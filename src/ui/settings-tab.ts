import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ObsyncPlugin from "../../main";
import { SyncEngine } from "../core/engine";
import { HttpServerHandle } from "../core/transport";
import { listAllSnapshots, restoreSnapshot } from "../core/versioning";
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

    new Setting(containerEl).setName("Obsync").setHeading();
    containerEl.createEl("p", {
      text: "Free P2P sync for your vault. No cloud, no account.",
      cls: "obsync-muted",
    });

    if (this.plugin.isMobile()) {
      new Setting(containerEl)
        .setName("Setup")
        .setDesc("Tap to find your sync server automatically.")
        .addButton((b) =>
          b.setButtonText("Set up connection").onClick(async () => {
            await this.plugin.changeServer();
            this.display();
          })
        );
    }

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

    if (!this.plugin.isMobile()) {
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
    }

    if (this.plugin.isMobile()) {
      new Setting(containerEl)
        .setName("Connection")
        .setDesc(this.connectionDescription())
        .addButton((b) =>
          b.setButtonText("Test connection").onClick(async () => {
            const ok = await this.plugin.testConnection();
            new Notice(
              ok
                ? "Obsync: connected to your server."
                : "Obsync: couldn't reach the server. Check that it's running and both devices are on the same network."
            );
            this.display();
          })
        )
        .addButton((b) =>
          b.setButtonText("Change server").onClick(async () => {
            await this.plugin.changeServer();
            this.display();
          })
        );

      new Setting(containerEl)
        .setName("Server address (advanced)")
        .setDesc(
          "Auto-discovered on first launch — leave empty to search your network automatically. Enter manually only if auto-discovery can't find the server."
        )
        .addText((t) => {
          t.setPlaceholder("http://192.168.1.5:42042")
            .setValue(this.svc.serverUrl)
            .onChange(async (v) => {
              await this.plugin.saveServerUrl(v.trim());
              this.plugin.reschedulePoll();
            });
        });
    }

    new Setting(containerEl)
      .setName("Auto-sync")
      .setDesc(
        "Sync when files change and (on mobile) poll the server every interval (ms). Near-instant by default."
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.autoSyncEnabled)
          .onChange(async (v) => {
            await this.plugin.setAutoSync(v);
            this.display();
          })
      )
      .addText((t) => {
        t.setPlaceholder("250")
          .setValue(String(this.plugin.autoSyncIntervalMs));
        t.inputEl.addClass("obsync-input-compact");
        t.onChange(async (v) => {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n) && n >= 100) {
            await this.plugin.setAutoSyncInterval(n);
          }
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

    void this.renderPairing();
    void this.renderConflicts();
    void this.renderSnapshots();
  }

  private connectionDescription(): string {
    if (!this.plugin.isMobile()) {
      return this.svc.server
        ? `Server is running on this device (port ${this.svc.server.port}).`
        : "Server not running.";
    }
    switch (this.plugin.connectionStatus) {
      case "connecting":
        return "Connecting…";
      case "connected":
        return "Connected.";
      case "not_found":
        return "Server not found — retry, or enter the address manually below.";
      default:
        return "Not set up yet. Use Test connection to find your server.";
    }
  }

  private async renderPairing() {
    const { containerEl } = this;
    new Setting(containerEl).setName("Devices").setHeading();
    const pairing = this.svc.pairing;
    if (!pairing) {
      containerEl.createEl("p", {
        text: "Pairing is desktop-only.",
        cls: "obsync-muted",
      });
      return;
    }
    const pending = await pairing.pendingDevices();
    if (pending.length > 0) {
      new Setting(containerEl).setName("Awaiting approval").setHeading();
      for (const p of pending) {
        new Setting(containerEl)
          .setName(`${p.device_name} wants to pair`)
          .setDesc(`${p.fingerprint} · device ${p.device_id.slice(0, 8)}`)
          .addButton((b) =>
            b
              .setButtonText("Approve")
              .setCta()
              .onClick(async () => {
                await pairing.approveDevice(p);
                this.display();
              })
          );
      }
    }

    const devices = await pairing.approvedList();
    if (devices.length === 0) {
      containerEl.createEl("p", {
        text: "No approved devices yet. From your phone: Settings → Obsync → Sync now, then approve it here.",
        cls: "obsync-muted",
      });
      return;
    }
    new Setting(containerEl).setName("Approved devices").setHeading();
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
    new Setting(containerEl).setName("Conflicts").setHeading();
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
      new Setting(containerEl)
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
    new Setting(containerEl).setName("Versions").setHeading();
    const adapter = this.svc.engine ? this.plugin.vaultAdapter() : null;
    if (!adapter) {
      containerEl.createEl("p", { text: "Engine not started.", cls: "obsync-muted" });
      return;
    }
    const snaps = await listAllSnapshots(adapter);
    if (snaps.length === 0) {
      containerEl.createEl("p", {
        text: "No snapshots yet (created on overwrite during sync).",
        cls: "obsync-muted",
      });
      return;
    }
    for (const s of snaps.slice(0, 20)) {
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
