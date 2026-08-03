import { contentHash as blake3Hash } from "./hash";
import { shouldIgnore } from "./ignore";
import { Blake3Hash, FileState, SyncState } from "./state";
import { VaultAdapter } from "./vault";

export interface ScanResult {
  files: FileState[];
  revisionCounter: number;
}

export interface ExistingState {
  size: number;
  modified_at: number;
  content_hash: Blake3Hash;
}

/**
 * Port of core/src/index/scanner.rs::scan_vault_incremental.
 *
 * Walks the vault adapter's file list (no disk walking — Obsidian's
 * `vault.getFiles()` is the source), applying ignore rules, and re-hashes only
 * files whose (size, mtime) changed since `existing`. Unchanged files reuse the
 * stored hash so a pre-sync refresh_index is cheap.
 *
 * `revisionCounter` counts scanned files (each scan result file gets a
 * sequential revision) — matches the Rust scan order semantics.
 */
export async function scanVault(
  vault: VaultAdapter,
  existing?: Map<string, ExistingState> | null
): Promise<ScanResult> {
  const all = await vault.listFiles();
  const files: FileState[] = [];
  let revisionCounter = 0;

  for (const rel of all) {
    if (shouldIgnore(rel)) continue;

    const stat = await vault.stat(rel);
    if (!stat) continue;

    const known = existing?.get(rel);
    let contentHash: Blake3Hash;
    if (known && known.size === stat.size && known.modified_at === stat.mtime) {
      contentHash = known.content_hash;
    } else {
      const bytes = await vault.readBinary(rel);
      contentHash = blake3Hash(bytes);
    }

    revisionCounter += 1;
    files.push({
      relative_path: rel,
      content_hash: contentHash,
      size: stat.size,
      modified_at: stat.mtime,
      revision: revisionCounter,
      sync_state: SyncState.Synced,
      synced_hash: null,
    });
  }

  return { files, revisionCounter };
}

/** Port of scan_file — hash a single known path, caller assigns revision. */
export async function scanFile(vault: VaultAdapter, rel: string): Promise<FileState> {
  const stat = await vault.stat(rel);
  if (!stat) throw new Error(`file not found: ${rel}`);
  const bytes = await vault.readBinary(rel);
  return {
    relative_path: rel,
    content_hash: blake3Hash(bytes),
    size: stat.size,
    modified_at: stat.mtime,
    revision: 0,
    sync_state: SyncState.Synced,
    synced_hash: null,
  };
}
