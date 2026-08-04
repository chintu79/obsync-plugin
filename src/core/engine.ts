import { compareManifests, ManifestDiff } from "./compare";
import { ConflictEntry } from "./store";
import { scanFile, scanVault, ExistingState } from "./scanner";
import { FileState, Manifest, RevisionId, SyncState } from "./state";
import { Store } from "./store";
import { SyncOperation } from "./delta";
import { VaultAdapter } from "./vault";

export enum SyncStateMachine {
  Idle = "idle",
  Discovering = "discovering",
  Connecting = "connecting",
  Syncing = "syncing",
  Conflict = "conflict",
  Offline = "offline",
  Error = "error",
}

export type Resolution = "keep_local" | "keep_remote" | "keep_both" | "open_file";

export interface SyncReport {
  pulled_files: number;
  pushed_files: number;
  deleted_files: number;
  conflicts: number;
}

function nowMillis(): number {
  return Date.now();
}

async function hashVaultFile(vault: VaultAdapter, rel: string): Promise<FileState> {
  return scanFile(vault, rel);
}

/**
 * Port of core/src/sync/engine.rs. All logic mirrors the Rust verbatim;
 * only the backing store (JSON instead of SQLite) and filesystem access (the
 * vault adapter instead of std::fs) differ.
 */
export class SyncEngine {
  private state: SyncStateMachine = SyncStateMachine.Idle;
  private revisionCounter: RevisionId = 0;
  private loaded = false;

  constructor(
    private vault: VaultAdapter,
    private store: Store,
    private deviceId: string
  ) {}

  async init(): Promise<void> {
    await this.store.load();
    const counter = await this.store.getConfig("revision_counter");
    if (counter !== null) this.revisionCounter = Number(counter);
    this.loaded = true;
  }

  private async requireLoaded(): Promise<void> {
    if (!this.loaded) await this.init();
  }

  stateMachine(): SyncStateMachine {
    return this.state;
  }

  setState(newState: SyncStateMachine): void {
    this.state = newState;
  }

  deviceIdValue(): string {
    return this.deviceId;
  }

  vaultAdapter(): VaultAdapter {
    return this.vault;
  }

  /** Port of record_remote_file. */
  async recordRemoteFile(
    path: string,
    contentHash: Uint8Array,
    size: number,
    modifiedAt: number
  ): Promise<void> {
    await this.requireLoaded();
    this.revisionCounter += 1;
    const state = newFileStateSynced(path, contentHash, size, modifiedAt, this.revisionCounter);
    state.synced_hash = contentHash;
    await this.store.upsertFileState(state);
    await this.saveRevisionCounter();
  }

  /** Port of mark_synced. */
  async markSynced(path: string): Promise<void> {
    await this.requireLoaded();
    const existing = await this.store.getFileState(path);
    if (existing) {
      existing.sync_state = SyncState.Synced;
      existing.synced_hash = existing.content_hash;
      await this.store.upsertFileState(existing);
    }
  }

  /** Port of mark_conflict. */
  async markConflict(path: string): Promise<void> {
    await this.requireLoaded();
    const existing = await this.store.getFileState(path);
    if (existing) {
      existing.sync_state = SyncState.Conflict;
      await this.store.upsertFileState(existing);
    }
  }

  /** Port of store_record_conflict. */
  async storeRecordConflict(
    path: string,
    localHash: Uint8Array | null,
    remoteHash: Uint8Array | null
  ): Promise<void> {
    await this.requireLoaded();
    await this.store.recordConflict(path, localHash, remoteHash);
  }

  /** Port of plan_conflict_copy. */
  async planConflictCopy(
    path: string,
    remoteHash: Uint8Array,
    force: boolean
  ): Promise<string | null> {
    await this.requireLoaded();
    const local = await this.store.getFileState(path);
    if (!local) return null;
    if (bytesEqual(local.content_hash, remoteHash)) return null;
    const localUnsynced =
      local.synced_hash !== null && !bytesEqual(local.synced_hash, local.content_hash);
    if (!force && !localUnsynced) return null;

    const copy = await this.conflictCopyPath(path, remoteHash);
    await this.markConflict(path);
    await this.store.recordConflict(path, local.content_hash, remoteHash);
    return copy;
  }

  private async conflictCopyPath(path: string, remoteHash: Uint8Array): Promise<string> {
    const base = generateConflictPath(path, this.deviceId);
    if (!(await this.vault.exists(base))) return base;

    const stem = stemOf(base);
    const ext = extensionOf(base);
    const hash8 = hexOf(remoteHash.slice(0, 4));
    for (let i = 0; i < 16; i++) {
      const suffix = i === 0 ? `-${hash8}` : `-${hash8}-${i}`;
      const name = `${stem}${suffix}${ext}`;
      const candidate = joinPath(dirOf(base), name);
      if (!(await this.vault.exists(candidate))) return candidate;
    }

    // All 16 hash-suffixed names are taken (a chronically-conflicting path).
    // Fall back to a timestamped name so the conflict still lands instead of
    // bailing and letting the caller abort the session.
    const stamped = joinPath(dirOf(base), `${stem}-${nowMillis()}${ext}`);
    if (!(await this.vault.exists(stamped))) return stamped;

    throw new Error(`could not allocate a conflict copy name for ${path}`);
  }

  /** Port of resolve_conflict. */
  async resolveConflict(rel: string, resolution: Resolution): Promise<void> {
    await this.requireLoaded();
    const entries = await this.store.getUnresolvedConflicts();
    const entry = entries.find((e) => e.relative_path === rel);
    if (!entry) throw new Error(`no unresolved conflict for ${rel}`);

    const copy = await findConflictCopy(this.vault, entry.relative_path);

    switch (resolution) {
      case "keep_local":
        if (copy) await this.vault.remove(copy);
        break;
      case "keep_remote":
        if (copy && (await this.vault.isFile(copy))) {
          const bytes = await this.vault.readBinary(copy);
          await this.vault.write(entry.relative_path, bytes);
          await this.vault.remove(copy);
        }
        break;
      case "keep_both":
      case "open_file":
        break;
    }

    await this.store.markConflictResolved(entry.id);

    const state = await hashVaultFile(this.vault, entry.relative_path);
    this.revisionCounter += 1;
    state.revision = this.revisionCounter;
    const existing = await this.store.getFileState(rel);
    state.synced_hash = existing ? existing.synced_hash : null;
    await this.store.upsertFileState(state);
    await this.saveRevisionCounter();
  }

  /** Port of conflicts(). */
  async conflicts(): Promise<ConflictEntry[]> {
    await this.requireLoaded();
    return this.store.getUnresolvedConflicts();
  }

  /** Port of initial_index. */
  async initialIndex(): Promise<void> {
    await this.requireLoaded();
    this.setState(SyncStateMachine.Syncing);
    const result = await scanVault(this.vault);
    for (const file of result.files) {
      await this.store.upsertFileState(file);
    }
    this.revisionCounter = result.revisionCounter;
    await this.saveRevisionCounter();
    this.setState(SyncStateMachine.Idle);
  }

  /** Port of refresh_index(detect_deletions). */
  async refreshIndex(detectDeletions: boolean): Promise<void> {
    await this.requireLoaded();
    this.setState(SyncStateMachine.Syncing);

    const existing = await this.store.getAllFileStates();
    const existingMap = new Map<string, ExistingState>();
    for (const s of existing) {
      existingMap.set(s.relative_path, {
        size: s.size,
        modified_at: s.modified_at,
        content_hash: s.content_hash,
      });
    }
    const result = await scanVault(this.vault, existingMap);
    const onDisk = new Map(result.files.map((f) => [f.relative_path, f]));

    for (const state of existing) {
      const disk = onDisk.get(state.relative_path);
      if (disk) {
        if (
          !bytesEqual(disk.content_hash, state.content_hash) ||
          disk.modified_at !== state.modified_at ||
          disk.size !== state.size
        ) {
          this.revisionCounter += 1;
          const updated = { ...disk, revision: this.revisionCounter };
          updated.synced_hash = state.synced_hash;
          await this.store.upsertFileState(updated);
        }
      } else if (detectDeletions) {
        this.revisionCounter += 1;
        await this.store.deleteFileState(state.relative_path);
        await this.store.upsertTombstone({
          relative_path: state.relative_path,
          revision: this.revisionCounter,
          deleted_at: nowMillis(),
          agreed_hash: state.synced_hash ?? state.content_hash,
        });
      }
      // else: missing from disk but not authoritative — leave as-is
    }

    for (const disk of result.files) {
      if (!existing.some((s) => s.relative_path === disk.relative_path)) {
        this.revisionCounter += 1;
        const state = { ...disk, revision: this.revisionCounter };
        await this.store.upsertFileState(state);
      }
    }

    await this.saveRevisionCounter();
    this.setState(SyncStateMachine.Idle);
  }

  /** Port of build_manifest. */
  async buildManifest(): Promise<Manifest> {
    await this.requireLoaded();
    const files = await this.store.getAllFileStates();
    const tombstones = await this.store.getTombstones();
    return {
      device_id: this.deviceId,
      files,
      tombstones,
      revision_counter: this.revisionCounter,
    };
  }

  /** Port of reconcile. */
  async reconcile(remote: Manifest): Promise<ManifestDiff> {
    await this.requireLoaded();
    const local = await this.buildManifest();
    const diff = compareManifests(local, remote);

    for (const [localFile] of diff.conflicts) {
      const existing = await this.store.getFileState(localFile.relative_path);
      if (existing) {
        existing.sync_state = SyncState.Conflict;
        await this.store.upsertFileState(existing);
      }
    }
    return diff;
  }

  /** Port of apply_operation. */
  async applyOperation(op: SyncOperation): Promise<void> {
    await this.requireLoaded();
    switch (op.op) {
      case "create":
        await this.applyCreate(op.path, op.content_hash, op.size, op.modified_at);
        break;
      case "update":
        await this.applyUpdate(op.path, op.content_hash, op.size, op.modified_at);
        break;
      case "delete":
        await this.applyDelete(op.path);
        break;
    }
  }

  private async applyCreate(
    path: string,
    _contentHash: Uint8Array,
    _size: number,
    _modifiedAt: number
  ): Promise<void> {
    if (await this.vault.exists(path)) {
      const state = await hashVaultFile(this.vault, path);
      this.revisionCounter += 1;
      state.revision = this.revisionCounter;
      await this.store.upsertFileState(state);
    }
  }

  private async applyUpdate(
    path: string,
    contentHash: Uint8Array,
    size: number,
    modifiedAt: number
  ): Promise<void> {
    const existing = await this.store.getFileState(path);
    if (
      existing &&
      !bytesEqual(existing.content_hash, contentHash) &&
      existing.synced_hash !== null &&
      !bytesEqual(existing.synced_hash, existing.content_hash)
    ) {
      return; // local edits not yet synced — surface conflict to UI
    }

    this.revisionCounter += 1;
    const state = newFileStateSynced(path, contentHash, size, modifiedAt, this.revisionCounter);
    state.synced_hash = contentHash;
    await this.store.upsertFileState(state);
    await this.saveRevisionCounter();
  }

  private async applyDelete(path: string): Promise<void> {
    if (await this.vault.exists(path)) {
      await this.vault.remove(path);
    }
    const state = await this.store.getFileState(path);
    await this.store.deleteFileState(path);
    this.revisionCounter += 1;
    await this.store.upsertTombstone({
      relative_path: path,
      revision: this.revisionCounter,
      deleted_at: nowMillis(),
      agreed_hash: state ? (state.synced_hash ?? state.content_hash) : null,
    });
  }

  async fileCount(): Promise<number> {
    await this.requireLoaded();
    return this.store.fileCount();
  }

  private async saveRevisionCounter(): Promise<void> {
    await this.store.setConfig("revision_counter", String(this.revisionCounter));
  }
}

// ---- helpers ----

function newFileStateSynced(
  path: string,
  contentHash: Uint8Array,
  size: number,
  modifiedAt: number,
  revision: RevisionId
): FileState {
  return {
    relative_path: path,
    content_hash: contentHash,
    size,
    modified_at: modifiedAt,
    revision,
    sync_state: SyncState.Synced,
    synced_hash: null,
  };
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function hexOf(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Port of ConflictResolver::generate_conflict_path. */
export function generateConflictPath(path: string, deviceId: string): string {
  const stem = stemOf(path);
  const ext = extensionOf(path);
  return joinPath(dirOf(path), `${stem}.conflict-${deviceId}${ext}`);
}

/** Port of ConflictResolver::find_conflict_copy. */
export async function findConflictCopy(vault: VaultAdapter, original: string): Promise<string | null> {
  const parent = dirOf(original);
  const name = original.split("/").pop() ?? "";
  const stem = stemOf(original);
  const all = await vault.listFiles();
  for (const p of all) {
    if (p === original) continue;
    if (!p.startsWith(parent.length ? `${parent}/` : "")) continue;
    const fileName = p.split("/").pop() ?? "";
    if (fileName.startsWith(`${name}.conflict-`) || fileName.startsWith(`${stem}.conflict-`)) {
      return p;
    }
  }
  return null;
}

function stemOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot);
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx) : "";
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}
