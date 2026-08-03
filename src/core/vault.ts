/**
 * The single seam that lets `src/core/` run inside Obsidian (desktop Node,
 * mobile Capacitor) and also in plain Node for vitest. Implementations:
 * - ObsidianVaultAdapter (plugin; uses this.app.vault.adapter + vault API)
 * - NodeVaultAdapter (tests; uses node:fs)
 *
 * `path` is always Obsidian-style "/"-separated, relative.
 */

export interface FileEntry {
  path: string;
}

export interface VaultAdapter {
  /** List all files in the vault (recursive), Obsidian style. */
  listFiles(): Promise<string[]>;

  /** Full content for a file, as UTF-8 string. */
  readText(path: string): Promise<string>;

  /** Raw bytes for a file. Throws if missing. */
  readBinary(path: string): Promise<Uint8Array>;

  /** Write (create) a file, overwriting if present. */
  write(path: string, data: Uint8Array | string): Promise<void>;

  /** Remove a file. */
  remove(path: string): Promise<void>;

  /** Rename/move a file. */
  rename(from: string, to: string): Promise<void>;

  /** Ensure a directory exists. */
  mkdir(path: string): Promise<void>;

  /** True if the path exists. */
  exists(path: string): Promise<boolean>;

  /** True if path is a file (not a dir). */
  isFile(path: string): Promise<boolean>;

  /** stat-ish: [mtime epoch millis, size bytes]. */
  stat(path: string): Promise<{ mtime: number; size: number } | null>;
}