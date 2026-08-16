import { Notice, Plugin, Platform, requestUrl } from "obsidian";
import { ObsidianVaultAdapter } from "./src/obsidian-adapter";
import { Store } from "./src/core/store";
import { SyncEngine } from "./src/core/engine";
import { SyncServer, runClientSession } from "./src/core/session";
import { PairingClient, PairingServer } from "./src/core/pairing";
import { newMessage } from "./src/core/protocol";
import {
  RequestUrlTransport,
  startRpcServer,
  HttpServerHandle,
  RPC_PATH,
  normalizeServerUrl,
} from "./src/core/transport";
import { DeviceIdentity, type StoredDeviceIdentity } from "./src/core/identity";
import { ObsyncSettingsTab } from "./src/ui/settings-tab";
import { VaultAdapter } from "./src/core/vault";

const DEFAULT_PORT = 42042;

export default class ObsyncPlugin extends Plugin {
  identity: DeviceIdentity | null = null;
  private engine: SyncEngine | null = null;
  private server: HttpServerHandle | null = null;
  private adapter: ObsidianVaultAdapter | null = null;
  private syncServer: SyncServer | null = null;
  private pairing: PairingServer | null = null;
  private statusBarItem: { setText: (text: string) => void } | null = null;

  /** Server URL configured in settings (mobile). */
  serverUrl = "";
  /** Auto-sync on vault changes + periodic polling. */
  autoSyncEnabled = true;
  autoSyncIntervalMs = 250;
  private syncInProgress = false;
  private syncDebounce: number | null = null;
  private pollTimer: number | null = null;

  async onload() {
    this.addRibbonIcon("refresh-ccw", "Obsync", () => this.syncNow());

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.syncNow(),
    });

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText("Obsync: idle");

    this.adapter = new ObsidianVaultAdapter(this.app.vault);

    // Load or generate device identity (persisted via loadData/saveData).
    const saved = (await this.loadData()) as {
      identity?: StoredDeviceIdentity;
      serverUrl?: string;
      autoSyncEnabled?: boolean;
      autoSyncIntervalMs?: number;
    } | null;
    if (saved?.identity) {
      this.identity = DeviceIdentity.fromStored(saved.identity);
    } else {
      this.identity = DeviceIdentity.generate(
        Platform.isMobile ? "Mobile" : "Desktop"
      );
      await this.saveData({ identity: this.identity.toStored() });
    }
    if (saved?.serverUrl) this.serverUrl = saved.serverUrl;
    if (typeof saved?.autoSyncEnabled === "boolean") this.autoSyncEnabled = saved.autoSyncEnabled;
    if (typeof saved?.autoSyncIntervalMs === "number") this.autoSyncIntervalMs = saved.autoSyncIntervalMs;

    // Engine over the vault adapter + JSON store.
    const store = new Store(this.adapter);
    this.engine = new SyncEngine(this.adapter, store, this.identity.device_id);
    await this.engine.init();

    if (Platform.isDesktop) {
      // A failed initial scan must not kill onload: the index is reconciled
      // by refreshIndex(true) at the start of every session hello, so an empty
      // or partial index here is self-healing. Swallow and move on.
      try {
        await this.engine.initialIndex();
      } catch (e) {
        console.warn(
          `obsync: initial index scan failed (will reconcile on first session): ${
            e instanceof Error ? e.message : e
          }`
        );
      }
      this.syncServer = new SyncServer(this.engine, this.adapter);
      this.pairing = new PairingServer(
        this.adapter,
        this.identity,
        this.syncServer
      );
      // Desktop is authoritative and must always be reachable — auto-start the
      // sync server instead of requiring a manual click in Settings. If the
      // bind races with the previous instance's socket (EADDRINUSE), retry a
      // few times before giving up.
      if (!this.server) {
        const pairing = this.pairing;
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < 5 && !this.server; attempt++) {
          try {
            this.server = await startRpcServer(
              (msg) => pairing.handle(msg),
              DEFAULT_PORT
            );
          } catch (e) {
            lastErr = e;
            console.warn(`obsync: server auto-start attempt ${attempt + 1} failed:`, e);
            await new Promise((res) => globalThis.setTimeout(res, 1000));
          }
        }
        if (!this.server) {
          console.error("obsync: could not auto-start sync server:", lastErr);
        }
      }
    }

    // Auto-sync: vault edits trigger an immediate (debounced) session, and on
    // mobile a periodic poll fetches remote changes (HTTP is request/response —
    // there is no push channel, so the phone polls instead).
    this.registerEvent(this.app.vault.on("create", () => this.scheduleAutoSync()));
    this.registerEvent(this.app.vault.on("modify", () => this.scheduleAutoSync()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleAutoSync()));

    this.reschedulePoll();

    this.addSettingTab(new ObsyncSettingsTab(this.app, this, this.serviceState()));

    new Notice(`Obsync ready (${this.identity.fingerprint()})`);
  }

  onunload() {
    void this.server?.close();
    if (this.syncDebounce !== null) window.clearTimeout(this.syncDebounce);
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
  }

  /** Re-arm the mobile poll timer after settings change / toggle. */
  reschedulePoll(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (!this.autoSyncEnabled || !Platform.isMobile) return;
    this.pollTimer = window.setInterval(
      () => void this.syncNow(true),
      Math.max(100, this.autoSyncIntervalMs)
    );
  }

  async setAutoSync(enabled: boolean): Promise<void> {
    this.autoSyncEnabled = enabled;
    await this.saveData({ ...(await this.loadData()), autoSyncEnabled: enabled });
    this.reschedulePoll();
  }

  async setAutoSyncInterval(ms: number): Promise<void> {
    this.autoSyncIntervalMs = ms;
    await this.saveData({ ...(await this.loadData()), autoSyncIntervalMs: ms });
    this.reschedulePoll();
  }

  /** Debounced auto-sync on vault file events. */
  private scheduleAutoSync(): void {
    if (!this.autoSyncEnabled || this.syncInProgress) return;
    if (this.syncDebounce !== null) window.clearTimeout(this.syncDebounce);
    this.syncDebounce = window.setTimeout(() => {
      this.syncDebounce = null;
      void this.syncNow(true);
    }, 150);
  }

  vaultAdapter(): VaultAdapter | null {
    return this.adapter;
  }

  isMobile(): boolean {
    return Platform.isMobile;
  }

  private serviceState() {
    return {
      engine: this.engine,
      server: this.server,
      serverUrl: this.serverUrl,
      pairing: this.pairing,
    } as const;
  }

  async saveServerUrl(url: string): Promise<void> {
    this.serverUrl = normalizeServerUrl(url);
    await this.saveData({ ...(await this.loadData()), serverUrl: this.serverUrl });
  }

  async toggleServer(): Promise<void> {
    if (Platform.isMobile) {
      new Notice("The sync server runs on desktop only.");
      return;
    }
    if (this.server) {
      await this.server.close();
      this.server = null;
      return;
    }
    if (!this.pairing) return;
    try {
      this.server = await startRpcServer((msg) => this.pairing!.handle(msg), DEFAULT_PORT);
      new Notice(`Obsync server listening on :${this.server.port}`);
    } catch (e) {
      new Notice(`Could not start server: ${e instanceof Error ? e.message : e}`);
    }
  }

  async syncNow(quiet = false): Promise<void> {
    if (!this.engine || !this.adapter || !this.identity) return;
    if (this.syncInProgress) return;
    this.syncInProgress = true;
    try {
      if (Platform.isMobile) {
        await this.mobileSync(quiet);
      } else {
        await this.desktopSync(quiet);
      }
    } finally {
      this.syncInProgress = false;
    }
  }

  private async desktopSync(quiet: boolean): Promise<void> {
    if (!this.engine || !this.server) {
      new Notice("Obsync: start the server first (Settings → Obsync).");
      return;
    }
    // Desktop is authoritative: deletions are tombstoned.
    await this.engine.refreshIndex(true);
    const url = `http://127.0.0.1:${this.server.port}${RPC_PATH}`;
    // Use requestUrl (not global fetch): Obsidian's renderer has no reliable
    // fetch for loopback, and requestUrl works identically on desktop + mobile.
    const transport = new RequestUrlTransport(url, (param) => {
      return requestUrl({
        url: param.url,
        method: param.method,
        contentType: param.contentType,
        body: param.body,
        throw: false,
      });
    });
    this.statusBarItem?.setText("Obsync: syncing…");
    try {
      const report = await runClientSession(this.engine, transport);
      this.statusBarItem?.setText("Obsync: up to date");
      if (!quiet) {
        new Notice(
          `Obsync sync: pulled=${report.pulled_files} pushed=${report.pushed_files} deleted=${report.deleted_files} conflicts=${report.conflicts}`
        );
      }
    } catch (e) {
      this.statusBarItem?.setText("Obsync: error");
      if (!quiet) new Notice(`Obsync sync failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async mobileSync(quiet: boolean): Promise<void> {
    if (!this.engine || !this.identity) return;
    if (!this.serverUrl) {
      if (!quiet) new Notice("Obsync: set the desktop server URL in settings.");
      return;
    }
    const url = `${normalizeServerUrl(this.serverUrl)}${RPC_PATH}`;
    const transport = new RequestUrlTransport(url, (param) => {
      return requestUrl({
        url: param.url,
        method: param.method,
        contentType: param.contentType,
        body: param.body,
        throw: false,
      });
    });

    // Pair (idempotent: pair_ack returns approved status for known devices).
    const pair = new PairingClient(this.identity);
    const pairReply = await transport.exchange(
      newMessage("pair_request", 0, pair.buildPairRequest())
    );
    if (pairReply.message_type === "pair_ack" && !(pairReply.payload as { approved: boolean }).approved) {
      if (!quiet) new Notice("Obsync: device not approved by the desktop. Ask the desktop user to approve.");
      return;
    }

    // Mobile is additive: never tombstone phantom deletions.
    await this.engine.refreshIndex(false);
    this.statusBarItem?.setText("Obsync: syncing…");
    try {
      const report = await runClientSession(this.engine, transport);
      this.statusBarItem?.setText("Obsync: up to date");
      if (!quiet) {
        new Notice(
          `Obsync sync: pulled=${report.pulled_files} pushed=${report.pushed_files} deleted=${report.deleted_files} conflicts=${report.conflicts}`
        );
      }
    } catch (e) {
      this.statusBarItem?.setText("Obsync: error");
      if (!quiet) new Notice(`Obsync sync failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
