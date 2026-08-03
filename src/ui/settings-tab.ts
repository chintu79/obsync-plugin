import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ObsyncPlugin from "../../main";
import { SyncEngine, SyncStateMachine } from "../core/engine";
import { DeviceIdentity } from "../core/identity";
import { SyncServer } from "../core/session";
import { HttpClientTransport, startRpcServer, HttpServerHandle } from "../core/transport";
import { ObsidianVaultAdapter } from "../obsidian-adapter";
import { Store } from "../core/store";
import { listSnapshots, restoreSnapshot } from "../core/versioning";
import { PairingServer } from "../core/pairing";

interface ServiceState {
  engine: SyncEngine | null;
  server: HttpServerHandle | null;
  serverUrl: string;
  pairing: PairingServer | null;
}

export class ObsyncSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: ObsyncPlugin,
    private svc: ServiceState
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obsync" });
    containerEl.createEl("p", {
      text: "Free P2P sync for your vault. No cloud, no account.",
      cls: "obsync-muted",
    });

    new Setting(containerEl)
      .setName("Device identity")
      .setDesc(
        this.svc.engine?.deviceIdValue()
          ? `device_id ${this.svc.engine.deviceIdValue()}`
          : "Engine not started."
      )
      .addButton((b) =>
        b.setButtonText("Show fingerprint").onClick(() => {
          const fp = this.plugin.identity?.fingerprint();
          new Notice(fp ? `Fingerprint: ${fp}` : "No identity yet");
        })
      );

    new Setting(containerEl)
      .setName("Sync server")
      .setDesc(
        this.svc.server
          ? `Listening on ${this.svc.serverUrl}`
          : "Not listening (desktop only)."
      )
      .addButton((b) =>
        b
          .setButtonText(this.svc.server ? "Stop" : "Start")
          .onClick(async () => {
            await this.plugin.toggleServer();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Sync server URL (mobile)")
      .setDesc("The laptop's hotspot IP + port, e.g. http://10.174.223.140:42042")
      .addText((t) => {
        t.setPlaceholder("http://<desktop-ip>:42042")
          .setValue(this.svc.serverUrl)
          .onChange(async (v) => {
            await this.plugin.saveServerUrl(v.trim());
          });
      });

    new Setting(containerEl)
      .setName("Sync now")
      .addButton((b) =>
        b.setButtonText("Sync").onClick(async () => {
          await this.plugin.syncNow();
          this.display();
        })
      );

    this.renderPairing();
    this.renderConflicts();
    this.renderSnapshots();
  }

  private async renderPairing() {
    const { containerEl } = this;
    containerEl.createEl("h3", { text: "Devices" });
    const pairing = this.svc.pairing;
    if (!pairing) {
      containerEl.createEl("p", {
        text: "Pairing is desktop-only.",
        cls: "obsync-muted",
      });
      return;
    }
    const devices = await pairing.approvedList();
    if (devices.length === 0) {
      containerEl.createEl("p", {
        text: "No approved devices. Sync from your phone to pair.",
        cls: "obsync-muted",
      });
      return;
    }
    for (const d of devices) {
      new Setting(containerEl)
        .setName(d.device_name)
        .setDesc(`${d.fingerprint} · approved ${new Date(d.approved_at).toLocaleString()}`)
        .addButton((b) =>
          b.setButtonText("Remove").onClick(async () => {
            await pairing.rejectDevice(d.device_id);
            this.display();
          })
        );
    }
  }

  private async renderConflicts() {
    const { containerEl } = this;
    containerEl.createEl("h3", { text: "Conflicts" });
    const engine = this.svc.engine;
    if (!engine) {
      containerEl.createEl("p", { text: "Engine not started.", cls: "obsync-muted" });
      return;
    }
    const conflicts = await engine.conflicts();
    if (conflicts.length === 0) {
      containerEl.createEl("p", { text: "No unresolved conflicts.", cls: "obsync-muted" });
      return;
    }
    for (const c of conflicts) {
      const item = new Setting(containerEl)
        .setName(c.relative_path)
        .setDesc(`Detected ${new Date(c.detected_at).toLocaleString()}`)
        .addButton((b) =>
          b.setButtonText("Keep local").onClick(async () => {
            await engine.resolveConflict(c.relative_path, "keep_local");
            this.display();
          })
        )
        .addButton((b) =>
          b.setButtonText("Keep remote").onClick(async () => {
            await engine.resolveConflict(c.relative_path, "keep_remote");
            this.display();
          })
        )
        .addButton((b) =>
          b.setButtonText("Keep both").onClick(async () => {
            await engine.resolveConflict(c.relative_path, "keep_both");
            this.display();
          })
        );
    }
  }

  private async renderSnapshots() {
    const { containerEl } = this;
    containerEl.createEl("h3", { text: "Versions" });
    const adapter = this.svc.engine ? this.plugin.vaultAdapter() : null;
    if (!adapter) {
      containerEl.createEl("p", { text: "Engine not started.", cls: "obsync-muted" });
      return;
    }
    const snaps = await listSnapshots(adapter, "notes/example.md");
    if (snaps.length === 0) {
      containerEl.createEl("p", {
        text: "No snapshots yet (created on overwrite during sync).",
        cls: "obsync-muted",
      });
      return;
    }
    for (const s of snaps.slice(0, 10)) {
      new Setting(containerEl)
        .setName(s.relative_path)
        .setDesc(`${new Date(s.timestamp).toLocaleString()} · ${s.size} bytes`)
        .addButton((b) =>
          b.setButtonText("Restore").onClick(async () => {
            await restoreSnapshot(adapter, s.relative_path, s.timestamp);
            new Notice(`Restored ${s.relative_path}`);
            this.display();
          })
        );
    }
  }
}
