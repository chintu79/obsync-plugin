import { Notice, Plugin, Platform, requestUrl } from "obsidian";
import { ObsidianVaultAdapter } from "./src/obsidian-adapter";
import { Store } from "./src/core/store";
import { SyncEngine } from "./src/core/engine";
import { SyncServer, runClientSession } from "./src/core/session";
import { PairingClient, PairingServer } from "./src/core/pairing";
import type { PairAckPayload } from "./src/core/protocol";
import { newMessage } from "./src/core/protocol";
import {
  RequestUrlTransport,
  startRawRpcServer,
  HttpServerHandle,
  RPC_PATH,
  normalizeServerUrl,
} from "./src/core/transport";
import { SecureGate } from "./src/core/secure";
import { discoverServer, obsidianProbe, type ServerProbe } from "./src/core/discovery";
import { ObsyncOnboardingModal } from "./src/ui/onboarding";
import { DeviceIdentity, type StoredDeviceIdentity } from "./src/core/identity";
import { ObsyncSettingsTab } from "./src/ui/settings-tab";
import { VaultAdapter } from "./src/core/vault";
import type { Scope, ScopeEntry, ScopeMode } from "./src/core/scope";
import {
  allows,
  effectiveLocalScope,
  hasFolderEntry,
  parseScope,
} from "./src/core/scope";

const DEFAULT_PORT = 42042;

/** Vault-relative "/"-separated path (Obsidian paths already use "/", but
 *  normalize defensively so a stray backslash can't bypass an exclusion). */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export default class ObsyncPlugin extends Plugin {
  identity: DeviceIdentity | null = null;
  private engine: SyncEngine | null = null;
  private server: HttpServerHandle | null = null;
  private adapter: ObsidianVaultAdapter | null = null;
  private syncServer: SyncServer | null = null;
  private pairing: PairingServer | null = null;
  private statusBarEl: HTMLElement | null = null;

  /** Server URL configured in settings (mobile). */
  serverUrl = "";
  /** Auto-sync on vault changes + periodic polling. */
  autoSyncEnabled = true;
  autoSyncIntervalMs = 250;
  private syncInProgress = false;
  private syncDebounce: number | null = null;
  private pollTimer: number | null = null;

  /** Connection state surfaced in the status bar + settings. */
  connectionStatus: "unknown" | "connecting" | "connected" | "not_found" = "unknown";
  private probeFn: ServerProbe | null = null;
  private onboardingOpen = false;

  /** Per-file exclusions ("don't sync this file"). Pure filter: excluded
   *  files stay on disk and re-including resumes the last agreement. */
  private syncExcludes = new Set<string>();
  /** "everything" (default) = whole vault minus exclusions; "selected" =
   *  only picked files/folders, minus exclusions. */
  private scopeMode: ScopeMode = "everything";
  /** Picked files/folders for "selected" mode. */
  private scopeEntries: ScopeEntry[] = [];
  /** Pairing verification code shown on this device (SAS from the ECDH
   *  secret). Equal to the desktop's code iff the pairing is uncompromised. */
  private verifyCode = "";

  async onload() {
    this.addRibbonIcon("refresh-ccw", "Obsync", () => this.syncNow());

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.syncNow(),
    });

    this.addCommand({
      id: "open-onboarding",
      name: "Set up connection",
      callback: () => this.openOnboarding(),
    });

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("mod-clickable");
    this.statusBarEl.addEventListener("click", () => this.onStatusBarClick());
    this.updateStatusBar();

    this.adapter = new ObsidianVaultAdapter(this.app.vault);

    // Load or generate device identity (persisted via loadData/saveData).
    const saved = (await this.loadData()) as {
      identity?: StoredDeviceIdentity;
      serverUrl?: string;
      autoSyncEnabled?: boolean;
      autoSyncIntervalMs?: number;
      scopeExcludes?: string[];
      scopeMode?: string;
      scopeEntries?: ScopeEntry[];
      verifyCode?: string;
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
    if (Array.isArray(saved?.scopeExcludes)) {
      this.syncExcludes = new Set(saved.scopeExcludes.map(normalizePath));
    }
    if (saved?.scopeMode === "selected") this.scopeMode = "selected";
    this.scopeEntries = parseScope({ entries: saved?.scopeEntries }).entries;
    if (typeof saved?.verifyCode === "string") this.verifyCode = saved.verifyCode;

    // Probe client for zero-config discovery (mobile path; harmless on desktop).
    this.probeFn = obsidianProbe((param) => requestUrl(param));

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
      this.syncServer = new SyncServer(this.engine, this.adapter, () =>
        this.localScope()
      );
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
        const gate = new SecureGate(pairing);
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < 5 && !this.server; attempt++) {
          try {
            this.server = await startRawRpcServer(
              (body) => gate.handleBody(body),
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

    if (Platform.isDesktop) {
      this.connectionStatus = "connected";
      this.updateStatusBar();
    } else {
      // Mobile: connect to the desktop server. With a saved URL, probe it
      // first; otherwise open the onboarding flow to auto-discover.
      if (this.serverUrl) {
        void this.checkSavedServer(this.serverUrl);
      } else {
        this.openOnboarding();
      }
    }

    // Auto-sync: vault edits trigger an immediate (debounced) session, and on
    // mobile a periodic poll fetches remote changes (HTTP is request/response —
    // there is no push channel, so the phone polls instead).
    this.registerEvent(this.app.vault.on("create", () => this.scheduleAutoSync()));
    this.registerEvent(this.app.vault.on("modify", () => this.scheduleAutoSync()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleAutoSync()));

    // Per-file/per-folder sync selection in the menus. Exclusion is a pure
    // filter (the file stays on disk); inclusion only bites in "selected"
    // mode, where a folder entry also covers future files under it.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        const path = normalizePath(file.path);
        if ("extension" in file) {
          this.addFileSyncMenuItem(menu, path);
        } else if (this.scopeMode === "selected") {
          this.addFolderSyncMenuItem(menu, path);
        }
      })
    );

    this.reschedulePoll();

    this.addSettingTab(new ObsyncSettingsTab(this.app, this, this.serviceState()));

    if (!Platform.isMobile) {
      new Notice(`Obsync ready (${this.identity.fingerprint()})`);
    }
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
    if (!this.autoSyncEnabled || !Platform.isMobile || !this.serverUrl) return;
    this.pollTimer = window.setInterval(
      () => void this.syncNow(true),
      Math.max(100, this.autoSyncIntervalMs)
    );
  }

  /** Status bar text for the current connection state. */
  private updateStatusBar(): void {
    if (!this.statusBarEl) return;
    if (Platform.isDesktop) {
      this.statusBarEl.setText(
        this.server ? `Obsync: server on :${this.server.port}` : "Obsync: idle"
      );
      return;
    }
    switch (this.connectionStatus) {
      case "connecting":
        this.statusBarEl.setText("Obsync: connecting…");
        break;
      case "connected":
        this.statusBarEl.setText("Obsync: connected");
        break;
      case "not_found":
        this.statusBarEl.setText("Obsync: server not found");
        break;
      default:
        this.statusBarEl.setText("Obsync: not set up");
        break;
    }
  }

  private onStatusBarClick(): void {
    if (Platform.isMobile) this.openOnboarding();
    else new Notice("Obsync server is running on this device.");
  }

  /** Probe a specific base URL (no discovery). */
  private async probeServerUrl(url: string): Promise<boolean> {
    if (!this.probeFn) return false;
    return this.probeFn(normalizeServerUrl(url), 4000);
  }

  /** On launch, verify a persisted URL; fall back to onboarding if offline. */
  private async checkSavedServer(url: string): Promise<void> {
    this.connectionStatus = "connecting";
    this.updateStatusBar();
    const ok = await this.probeServerUrl(url);
    if (ok) {
      this.connectionStatus = "connected";
    } else {
      this.connectionStatus = "not_found";
      this.openOnboarding(url);
    }
    this.updateStatusBar();
  }

  /** Open the zero-config onboarding modal (mobile only). */
  private openOnboarding(prefillUrl?: string): void {
    if (Platform.isDesktop) {
      new Notice("Obsync server is running on this device — nothing to set up.");
      return;
    }
    if (this.onboardingOpen || !this.probeFn) return;
    this.onboardingOpen = true;
    this.connectionStatus = "connecting";
    this.updateStatusBar();
    const modal = new ObsyncOnboardingModal(this.app, {
      savedUrl: prefillUrl ?? this.serverUrl,
      discover: async () => {
        const outcome = await discoverServer({
          probe: this.probeFn!,
          onProgress: (tried, total) => modal.setProgress(tried, total),
        });
        return outcome.found ? outcome.url! : null;
      },
      probe: (url) => this.probeServerUrl(url),
      onConnected: async (url) => {
        await this.saveServerUrl(url);
        this.connectionStatus = "connected";
        this.updateStatusBar();
        this.reschedulePoll();
        new Notice("Obsync connected.");
      },
    });
    modal.onClose = () => {
      this.onboardingOpen = false;
    };
    modal.open();
  }

  /** Clear the saved server and re-run discovery (from Settings). */
  async changeServer(): Promise<void> {
    if (Platform.isDesktop) {
      new Notice("Obsync runs as the server on this device.");
      return;
    }
    await this.saveServerUrl("");
    this.connectionStatus = "unknown";
    this.updateStatusBar();
    this.openOnboarding();
  }

  /** Verify the current server (or discover one) and report to the user. */
  async testConnection(): Promise<boolean> {
    if (Platform.isDesktop) return true;
    if (!this.probeFn) return false;
    let url = this.serverUrl;
    if (!url) {
      const outcome = await discoverServer({ probe: this.probeFn });
      url = outcome.found ? outcome.url! : "";
    }
    if (!url) {
      this.connectionStatus = "not_found";
      this.updateStatusBar();
      return false;
    }
    const ok = await this.probeServerUrl(url);
    this.connectionStatus = ok ? "connected" : "not_found";
    this.updateStatusBar();
    return ok;
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

  /** This side's sync scope: whole vault minus per-file exclusions. */
  localScope(): Scope {
    return effectiveLocalScope(
      this.scopeMode,
      this.scopeEntries,
      [...this.syncExcludes].sort()
    );
  }

  /** Persist mode, picked entries, and exclusions. */
  async saveScope(): Promise<void> {
    await this.saveData({
      ...(await this.loadData()),
      scopeExcludes: [...this.syncExcludes].sort(),
      scopeMode: this.scopeMode,
      scopeEntries: [...this.scopeEntries].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind.localeCompare(b.kind)
      ),
    });
  }

  /** Sorted snapshot for the settings list. */
  excludedFiles(): string[] {
    return [...this.syncExcludes].sort();
  }

  async setFileExcluded(path: string, excluded: boolean): Promise<void> {
    const p = normalizePath(path);
    if (excluded) this.syncExcludes.add(p);
    else this.syncExcludes.delete(p);
    await this.saveScope();
  }

  getScopeMode(): ScopeMode {
    return this.scopeMode;
  }

  /** Derive + persist the pairing verification code for this server. */
  private async rememberVerifyCode(
    pair: PairingClient,
    serverPublicKeyHex: string
  ): Promise<void> {
    const code = pair.verifyCodeFor(serverPublicKeyHex);
    if (code === this.verifyCode) return;
    this.verifyCode = code;
    await this.saveData({
      ...(await this.loadData()),
      verifyCode: code,
    });
  }

  /** The pairing verification code to compare with the other device. */
  getVerifyCode(): string {
    return this.verifyCode;
  }

  async setScopeMode(mode: ScopeMode): Promise<void> {
    if (mode === this.scopeMode) return;
    this.scopeMode = mode;
    await this.saveScope();
    void this.syncNow(true);
  }

  /** Picked files/folders for "selected" mode, sorted for display. */
  includedPaths(): ScopeEntry[] {
    return [...this.scopeEntries].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind.localeCompare(b.kind)
    );
  }

  async addInclude(path: string, kind: ScopeEntry["kind"]): Promise<void> {
    const p = normalizePath(path);
    if (!this.scopeEntries.some((e) => e.kind === kind && e.path === p)) {
      this.scopeEntries.push({ kind, path: p });
    }
    await this.saveScope();
  }

  async removeInclude(path: string): Promise<void> {
    const p = normalizePath(path);
    this.scopeEntries = this.scopeEntries.filter((e) => e.path !== p);
    await this.saveScope();
  }

  /** File-menu item: toggle the file between synced and device-only. */
  private addFileSyncMenuItem(menu: any, path: string): void {
    const scope = this.localScope();
    const allowed = allows(scope, path);
    menu.addItem((item: any) =>
      item
        .setTitle(allowed ? "Don't sync this file" : "Sync this file")
        .setIcon(allowed ? "eye-off" : "eye")
        .onClick(async () => {
          if (allowed) {
            // Exclusions win over folder entries, so this works in both modes.
            this.syncExcludes.add(path);
          } else {
            this.syncExcludes.delete(path);
            // In selected mode make it part of the pick unless a covering
            // entry already allows it.
            if (this.scopeMode === "selected") {
              const without = effectiveLocalScope(
                this.scopeMode,
                this.scopeEntries,
                [...this.syncExcludes].sort()
              );
              if (!allows(without, path)) await this.addInclude(path, "file");
            }
          }
          await this.saveScope();
          new Notice(
            allowed
              ? `Obsync: not syncing ${path} (it stays on this device)`
              : `Obsync: syncing ${path}`
          );
          void this.syncNow(true);
        })
    );
  }

  /** Folder-menu item ("selected" mode only): include or drop a whole
   *  folder. A folder entry also covers future files created under it. */
  private addFolderSyncMenuItem(menu: any, path: string): void {
    const included = hasFolderEntry(this.localScope(), path);
    menu.addItem((item: any) =>
      item
        .setTitle(included ? "Don't sync this folder" : "Sync this folder")
        .setIcon(included ? "eye-off" : "eye")
        .onClick(async () => {
          if (included) {
            await this.removeInclude(path);
          } else {
            await this.removeInclude(path); // clean up stray same-path file entry
            await this.addInclude(path, "folder");
          }
          new Notice(
            included
              ? `Obsync: not syncing ${path}/ anymore`
              : `Obsync: syncing ${path}/`
          );
          void this.syncNow(true);
        })
    );
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
      const gate = new SecureGate(this.pairing);
      this.server = await startRawRpcServer((body) => gate.handleBody(body), DEFAULT_PORT);
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
    // The identity seals every session (X25519 + AES-GCM envelopes).
    const transport = new RequestUrlTransport(
      url,
      (param) => {
        return requestUrl({
          url: param.url,
          method: param.method,
          contentType: param.contentType,
          body: param.body,
          throw: false,
        });
      },
      15000,
      this.identity!
    );
    this.statusBarEl?.setText("Obsync: syncing…");
    try {
      const report = await runClientSession(this.engine, transport, undefined, this.localScope());
      this.statusBarEl?.setText("Obsync: up to date");
      if (!quiet) {
        new Notice(
          `Obsync sync: pulled=${report.pulled_files} pushed=${report.pushed_files} deleted=${report.deleted_files} conflicts=${report.conflicts}`
        );
      }
    } catch (e) {
      this.statusBarEl?.setText("Obsync: error");
      if (!quiet) new Notice(`Obsync sync failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async mobileSync(quiet: boolean): Promise<void> {
    if (!this.engine || !this.identity) return;
    if (!this.serverUrl) {
      if (!quiet)
        new Notice("Obsync: not connected yet. Tap the status bar to set up the server.");
      this.openOnboarding();
      return;
    }
    const url = `${normalizeServerUrl(this.serverUrl)}${RPC_PATH}`;
    const transport = new RequestUrlTransport(
      url,
      (param) => {
        return requestUrl({
          url: param.url,
          method: param.method,
          contentType: param.contentType,
          body: param.body,
          throw: false,
        });
      },
      15000,
      this.identity!
    );

    // Pair (idempotent: pair_ack returns approved status for known devices).
    const pair = new PairingClient(this.identity);
    const pairReply = await transport.exchange(
      newMessage("pair_request", 0, pair.buildPairRequest())
    );
    if (pairReply.message_type === "pair_ack") {
      const p = pairReply.payload as PairAckPayload & { approved: boolean };
      if (!p.approved) {
        if (!quiet) new Notice("Obsync: device not approved by the desktop. Ask the desktop user to approve.");
        // Show the code to compare while waiting for approval.
        if (p.server_public_key) await this.rememberVerifyCode(pair, p.server_public_key);
        return;
      }
      if (p.server_public_key) await this.rememberVerifyCode(pair, p.server_public_key);
    }

    // Mobile is additive: never tombstone phantom deletions.
    await this.engine.refreshIndex(false);
    this.statusBarEl?.setText("Obsync: syncing…");
    try {
      const report = await runClientSession(this.engine, transport, undefined, this.localScope());
      this.connectionStatus = "connected";
      this.updateStatusBar();
      if (!quiet) {
        new Notice(
          `Obsync sync: pulled=${report.pulled_files} pushed=${report.pushed_files} deleted=${report.deleted_files} conflicts=${report.conflicts}`
        );
      }
    } catch (e) {
      this.connectionStatus = "not_found";
      this.updateStatusBar();
      if (!quiet) new Notice(`Obsync sync failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
