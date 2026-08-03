import * as fs from "node:fs";
import * as path from "node:path";
import { VaultAdapter } from "./vault";

/**
 * Node implementation of VaultAdapter backed by a real directory.
 * Used by vitest (Phase 1) and potentially by a Node-based peer later.
 * `listFiles` walks the tree recursively and returns "/"-separated relative
 * paths (Obsidian style), including files under `.obsync/`.
 */
export class NodeVaultAdapter implements VaultAdapter {
  constructor(private root: string) {}

  private abs(rel: string): string {
    return path.join(this.root, rel);
  }

  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), rel);
        } else {
          out.push(rel);
        }
      }
    };
    if (fs.existsSync(this.root)) walk(this.root, "");
    return out;
  }

  async readText(rel: string): Promise<string> {
    return fs.readFileSync(this.abs(rel), "utf8");
  }

  async readBinary(rel: string): Promise<Uint8Array> {
    return new Uint8Array(fs.readFileSync(this.abs(rel)));
  }

  async write(rel: string, data: Uint8Array | string): Promise<void> {
    const abs = this.abs(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data as any);
  }

  async remove(rel: string): Promise<void> {
    fs.rmSync(this.abs(rel), { force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    fs.mkdirSync(path.dirname(this.abs(to)), { recursive: true });
    fs.renameSync(this.abs(from), this.abs(to));
  }

  async mkdir(rel: string): Promise<void> {
    fs.mkdirSync(this.abs(rel), { recursive: true });
  }

  async exists(rel: string): Promise<boolean> {
    return fs.existsSync(this.abs(rel));
  }

  async isFile(rel: string): Promise<boolean> {
    return fs.statSync(this.abs(rel), { throwIfNoEntry: false })?.isFile() ?? false;
  }

  async stat(rel: string): Promise<{ mtime: number; size: number } | null> {
    const st = fs.statSync(this.abs(rel), { throwIfNoEntry: false });
    return st ? { mtime: st.mtimeMs, size: st.size } : null;
  }
}