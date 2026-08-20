import { App, Modal, Setting, TextComponent } from "obsidian";

/**
 * First-run / reconnect onboarding for the mobile client. Holds the user's
 * hand from "Connecting…" to "Connected" without ever exposing an IP address
 * unless they explicitly choose the manual path.
 *
 * States:
 *   connecting  — running discovery (spinner + progress)
 *   connected   — success; a single "Done" dismisses the modal
 *   not_found   — nothing reachable; Retry or enter the URL manually
 *   manual      — explicit URL entry (the only place an address is shown)
 */

type State = "connecting" | "connected" | "not_found" | "manual";

export interface OnboardingCallbacks {
  /** Run discovery; resolve with the found base URL, or null if none. */
  discover: () => Promise<string | null>;
  /** Validate a manually entered URL. */
  probe: (url: string) => Promise<boolean>;
  /** Called with the chosen URL when the user confirms. */
  onConnected: (url: string) => void;
  /** Currently saved URL, if any (used to prefill the manual field). */
  savedUrl?: string;
}

export class ObsyncOnboardingModal extends Modal {
  private state: State = "connecting";
  private busy = false;
  private foundUrl: string | null = null;
  private manualInput: TextComponent | null = null;

  constructor(
    app: App,
    private callbacks: OnboardingCallbacks
  ) {
    super(app);
    this.titleEl.setText("Set up Obsync");
  }

  onOpen(): void {
    this.render("connecting");
    void this.runDiscovery();
  }

  private render(state: State): void {
    this.state = state;
    const el = this.contentEl;
    el.empty();
    el.addClass("obsync-onboarding");
    const status = el.createDiv("obsync-onboarding-status");
    switch (state) {
      case "connecting":
        status.addClass("obsync-onboarding-connecting");
        status.createSpan({ text: "Connecting…" });
        el.createEl("p", {
          text: "Looking for your sync server on this device and your network. This usually takes a few seconds.",
          cls: "obsync-muted",
        });
        el.createDiv("obsync-onboarding-progress").setText("");
        break;

      case "connected":
        status.addClass("obsync-onboarding-connected");
        status.createSpan({ text: "Connected" });
        el.createEl("p", {
          text: "Your vault is ready to sync.",
          cls: "obsync-muted",
        });
        new Setting(el).addButton((b) =>
          b.setButtonText("Done").setCta().onClick(() => {
            if (this.foundUrl) {
              this.callbacks.onConnected(this.foundUrl);
            }
            this.close();
          })
        );
        break;

      case "not_found":
        status.addClass("obsync-onboarding-notfound");
        status.createSpan({ text: "Server not found" });
        el.createEl("p", {
          text: "Make sure Obsync is running on your other device and that both devices are on the same network.",
          cls: "obsync-muted",
        });
        new Setting(el)
          .addButton((b) =>
            b.setButtonText("Retry").setCta().onClick(() => {
              this.render("connecting");
              void this.runDiscovery();
            })
          )
          .addButton((b) =>
            b.setButtonText("Enter server URL manually").onClick(() => this.render("manual"))
          );
        break;

      case "manual": {
        status.addClass("obsync-onboarding-manual");
        status.createSpan({ text: "Enter server address" });
        el.createEl("p", {
          text: "On the device running Obsync, the address is shown in Settings → Obsync → Connection.",
          cls: "obsync-muted",
        });
        new Setting(el)
          .setName("Server address")
          .addText((t) => {
            this.manualInput = t;
            t.setPlaceholder("http://192.168.1.5:42042").setValue(
              this.callbacks.savedUrl ?? ""
            );
          });
        el.createDiv("obsync-onboarding-error").setText("");
        new Setting(el)
          .addButton((b) =>
            b.setButtonText("Connect").setCta().onClick(() => {
              void this.connectManual();
            })
          )
          .addButton((b) =>
            b.setButtonText("Back to search").onClick(() => {
              this.render("connecting");
              void this.runDiscovery();
            })
          );
        break;
      }
    }
  }

  /** Live LAN-scan progress, rendered in the "Connecting…" state. */
  setProgress(tried: number, total: number): void {
    const el = this.contentEl.querySelector(".obsync-onboarding-progress");
    if (el) el.textContent = `Searching your network… ${tried}/${total}`;
  }

  private async runDiscovery(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const started = Date.now();
      const url = await this.callbacks.discover();
      const elapsed = Date.now() - started;
      if (url) {
        this.foundUrl = url;
        // Hold the success state on screen briefly so it reads as a real
        // outcome rather than a flash, then hand off.
        const hold = Math.max(0, 700 - elapsed);
        await new Promise((res) => globalThis.setTimeout(res, hold));
        this.render("connected");
      } else {
        this.render("not_found");
      }
    } finally {
      this.busy = false;
    }
  }

  private async connectManual(): Promise<void> {
    const url = (this.manualInput?.getValue() ?? "").trim();
    if (!url || this.busy) return;
    this.busy = true;
    try {
      const ok = await this.callbacks.probe(url);
      if (ok) {
        this.foundUrl = url;
        this.render("connected");
      } else {
        const error = this.contentEl.querySelector(".obsync-onboarding-error");
        if (error) {
          error.textContent =
            "Couldn't reach that address. Double-check it on the other device and try again.";
        }
      }
    } finally {
      this.busy = false;
    }
  }
}