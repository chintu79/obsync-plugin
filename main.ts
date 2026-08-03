import { Notice, Plugin, Platform, requestUrl } from "obsidian";
import { ObsidianVaultAdapter } from "./src/obsidian-adapter";
import { Store } from "./src/core/store";
import { SyncEngine } from "./src/core/engine";
import { SyncServer, runClientSession } from "./src/core/session";
import { PairingClient, PairingServer } from "./src/core/pairing";
import { newMessage } from "./src/core/protocol";
import {
  HttpClientTransport,
  RequestUrlTransport,
  startRpcServer,
  HttpServerHandle,
  RPC_PATH,
} from "./src/core/transport";
import { DeviceIdentity } from "./src/core/identity";
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
    const saved = await this.loadData();
    if (saved?.identity) {
      this.identity = DeviceIdentity.fromStored(saved.identity);
    } else {
      this.identity = DeviceIdentity.generate(
        Platform.isMobile ? "Mobile" : "Desktop"
      );
      await this.saveData({ identity: this.identity.toStored() });
    }
    if (saved?.serverUrl) this.serverUrl = saved.serverUrl;

    // Engine over the vault adapter + JSON store.
    const store = new Store(this.adapter);
    this.engine = new SyncEngine(this.adapter, store, this.identity.device_id);
    await this.engine.init();

    if (Platform.isDesktop) {
      await this.engine.initialIndex();
      this.syncServer = new SyncServer(this.engine, this.adapter);
      this.pairing = new PairingServer(
        this.adapter,
        this.identity,
        this.syncServer
      );
    }

    this.addSettingTab(new ObsyncSettingsTab(this.app, this, this.serviceState()));

    new Notice(`Obsync ready (${this.identity.fingerprint()})`);
  }

  onunload() {
    this.server?.close();
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
    this.serverUrl = url;
    await this.saveData({ ...(await this.loadData()), serverUrl: url });
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

  async syncNow(): Promise<void> {
    if (!this.engine || !this.adapter || !this.identity) return;

    if (Platform.isMobile) {
      await this.mobileSync();
      return;
    }
    await this.desktopSync();
  }

  private async desktopSync(): Promise<void> {
    if (!this.engine || !this.server) {
      new Notice("Obsync: start the server first (Settings → Obsync).");
      return;
    }
    // Desktop is authoritative: deletions are tombstoned.
    await this.engine.refreshIndex(true);
    const url = `http://127.0.0.1:${this.server.port}${RPC_PATH}`;
    const transport = HttpClientTransport.forNode(url);
    this.statusBarItem?.setText("Obsync: syncing…");
    try {
      const report = await runClientSession(this.engine, transport);
      this.statusBarItem?.setText("Obsync: up to date");
      new Notice(
        `Obsync sync: pulled=${report.pulled_files} pushed=${report.pushed_files} deleted=${report.deleted_files} conflicts=${report.conflicts}`
      );
    } catch (e) {
      this.statusBarItem?.setText("Obsync: error");
      new Notice(`Obsync sync failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async mobileSync(): Promise<void> {
    if (!this.engine || !this.identity) return;
    if (!this.serverUrl) {
      new Notice("Obsync: set the desktop server URL in settings.");
      return;
    }
    const url = `${this.serverUrl}${RPC_PATH}`;
    const transport = new RequestUrlTransport(url, (param) => {
      return requestUrl({
        url: param.url,
        method: param.method,
        contentType: param.contentType,
        body: param.body,
        throw: false,
      }) as unknown as Promise<{
        status: number;
        text: string;
        arrayBuffer: ArrayBuffer;
      }>;
    });

    // Pair (idempotent: pair_ack returns approved status for known devices).
    const pair = new PairingClient(this.identity);
    const pairReply = await transport.exchange(
      newMessage("pair_request", 0, pair.buildPairRequest())
    );
    if (pairReply.message_type === "pair_ack" && !(pairReply.payload as { approved: boolean }).approved) {
      new Notice("Obsync: device not approved by the desktop. Ask the desktop user to approve.");
      return;
    }

    // Mobile is additive: never tombstone phantom deletions.
    await this.engine.refreshIndex(false);
    this.statusBarItem?.setText("Obsync: syncing…");
    try {
      const report = await runClientSession(this.engine, transport);
      this.statusBarItem?.setText("Obsync: up to date");
      new Notice(
        `Obsync sync: pulled=${report.pulled_files} pushed=${report.pushed_files} deleted=${report.deleted_files} conflicts=${report.conflicts}`
      );
    } catch (e) {
      this.statusBarItem?.setText("Obsync: error");
      new Notice(`Obsync sync failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
