import { normalizePath, type DataAdapter, type Vault } from "obsidian";
import { VaultAdapter } from "./core/vault";

/**
 * VaultAdapter backed by Obsidian's DataAdapter (works on both desktop
 * FileSystemAdapter and mobile CapacitorAdapter). All paths are Obsidian-style
 * "/"-separated vault-relative paths normalized via normalizePath. listFiles
 * walks `list()` recursively.
 */
export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(private vault: Vault) {}

  private get adapter(): DataAdapter {
    return this.vault.adapter;
  }

  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
      const listed = await this.adapter.list(dir);
      for (const file of listed.files) out.push(file);
      for (const folder of listed.folders) await walk(folder);
    };
    await walk("");
    return out;
  }

  async readText(path: string): Promise<string> {
    return this.adapter.read(normalizePath(path));
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const buf = await this.adapter.readBinary(normalizePath(path));
    return new Uint8Array(buf);
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    const p = normalizePath(path);
    if (typeof data === "string") {
      await this.adapter.write(p, data);
    } else {
      const buf = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      ) as ArrayBuffer;
      await this.adapter.writeBinary(p, buf);
    }
  }

  async remove(path: string): Promise<void> {
    await this.adapter.remove(normalizePath(path));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.adapter.rename(normalizePath(from), normalizePath(to));
  }

  async mkdir(path: string): Promise<void> {
    const parts = normalizePath(path).split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!(await this.adapter.exists(cur))) {
        await this.adapter.mkdir(cur);
      }
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(normalizePath(path));
  }

  async isFile(path: string): Promise<boolean> {
    const stat = await this.adapter.stat(normalizePath(path));
    return stat !== null && stat.type === "file";
  }

  async stat(path: string): Promise<{ mtime: number; size: number } | null> {
    const s = await this.adapter.stat(normalizePath(path));
    if (!s) return null;
    return { mtime: s.mtime, size: s.size };
  }
}
