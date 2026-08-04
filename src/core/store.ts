import { Blake3Hash, FileState, SyncState, Tombstone } from "./state";
import { VaultAdapter } from "./vault";

export const INDEX_PATH = ".obsync/index.json";

export interface ConflictEntry {
  id: number;
  relative_path: string;
  local_hash: Blake3Hash | null;
  remote_hash: Blake3Hash | null;
  local_revision: number | null;
  remote_revision: number | null;
  detected_at: number;
  resolved: boolean;
}

export interface DeviceIdentity {
  device_id: string;
  public_key: Uint8Array;
  label?: string;
  paired_at: number;
  last_seen?: number;
}

interface SerializedFileState {
  relative_path: string;
  content_hash: string; // hex
  size: number;
  modified_at: number;
  revision: number;
  sync_state: number;
  synced_hash: string | null;
}

interface SerializedTombstone {
  relative_path: string;
  revision: number;
  deleted_at: number;
  agreed_hash: string | null;
}

interface SerializedConflict {
  id: number;
  relative_path: string;
  local_hash: string | null;
  remote_hash: string | null;
  detected_at: number;
  resolved: boolean;
}

interface SerializedDevice {
  device_id: string;
  public_key: string; // hex
  label?: string;
  paired_at: number;
  last_seen?: number;
}

interface SerializedIndex {
  schema: number;
  file_states: SerializedFileState[];
  tombstones: SerializedTombstone[];
  conflicts: SerializedConflict[];
  devices: SerializedDevice[];
  config: Record<string, string>;
}

function hex(h: Uint8Array): string {
  let out = "";
  for (const b of h) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function serializeHash(h: Uint8Array | null): string | null {
  return h === null ? null : hex(h);
}

function deserializeHash(s: string | null): Uint8Array | null {
  return s === null ? null : fromHex(s);
}

function stateFromSerialized(s: SerializedFileState): FileState {
  return {
    relative_path: s.relative_path,
    content_hash: fromHex(s.content_hash),
    size: s.size,
    modified_at: s.modified_at,
    revision: s.revision,
    sync_state: s.sync_state as SyncState,
    synced_hash: deserializeHash(s.synced_hash),
  };
}

function stateToSerialized(s: FileState): SerializedFileState {
  return {
    relative_path: s.relative_path,
    content_hash: hex(s.content_hash),
    size: s.size,
    modified_at: s.modified_at,
    revision: s.revision,
    sync_state: s.sync_state as number,
    synced_hash: serializeHash(s.synced_hash),
  };
}

/**
 * JSON-backed store on the vault adapter (port of core/src/index/store.rs +
 * storage/db.rs). The Rust version uses SQLite at `.obsync/obsync.db`; mobile
 * plugins cannot use SQLite, so this persists a Map to `.obsync/index.json`.
 * Same API surface: file states, tombstones, conflicts, devices, config.
 */
export class Store {
  private files = new Map<string, FileState>();
  private tombstones = new Map<string, Tombstone>();
  private conflicts: ConflictEntry[] = [];
  private devices = new Map<string, DeviceIdentity>();
  private config = new Map<string, string>();
  private nextConflictId = 1;
  private loaded = false;
  private indexPath: string;

  constructor(
    private vault: VaultAdapter,
    indexPath: string = INDEX_PATH
  ) {
    this.indexPath = indexPath;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!(await this.vault.exists(this.indexPath))) return;
    const raw = await this.vault.readText(this.indexPath);
    let data: SerializedIndex;
    try {
      data = JSON.parse(raw);
    } catch {
      return; // corrupt index → start fresh
    }
    for (const s of data.file_states ?? []) {
      const f = stateFromSerialized(s);
      this.files.set(f.relative_path, f);
    }
    for (const t of data.tombstones ?? []) {
      this.tombstones.set(t.relative_path, {
        relative_path: t.relative_path,
        revision: t.revision,
        deleted_at: t.deleted_at,
        agreed_hash: deserializeHash(t.agreed_hash ?? null),
      });
    }
    this.conflicts = (data.conflicts ?? []).map((c) => ({
      id: c.id,
      relative_path: c.relative_path,
      local_hash: deserializeHash(c.local_hash),
      remote_hash: deserializeHash(c.remote_hash),
      local_revision: null,
      remote_revision: null,
      detected_at: c.detected_at,
      resolved: c.resolved,
    }));
    for (const c of this.conflicts) {
      if (c.id >= this.nextConflictId) this.nextConflictId = c.id + 1;
    }
    for (const d of data.devices ?? []) {
      this.devices.set(d.device_id, {
        device_id: d.device_id,
        public_key: fromHex(d.public_key),
        label: d.label,
        paired_at: d.paired_at,
        last_seen: d.last_seen,
      });
    }
    for (const [k, v] of Object.entries(data.config ?? {})) {
      this.config.set(k, v);
    }
  }

  private async persist(): Promise<void> {
    const data: SerializedIndex = {
      schema: 2,
      file_states: [...this.files.values()].map(stateToSerialized),
      tombstones: [...this.tombstones.values()].map((t) => ({
        relative_path: t.relative_path,
        revision: t.revision,
        deleted_at: t.deleted_at,
        agreed_hash: serializeHash(t.agreed_hash ?? null),
      })),
      conflicts: this.conflicts.map((c) => ({
        id: c.id,
        relative_path: c.relative_path,
        local_hash: serializeHash(c.local_hash),
        remote_hash: serializeHash(c.remote_hash),
        detected_at: c.detected_at,
        resolved: c.resolved,
      })),
      devices: [...this.devices.values()].map((d) => ({
        device_id: d.device_id,
        public_key: hex(d.public_key),
        label: d.label,
        paired_at: d.paired_at,
        last_seen: d.last_seen,
      })),
      config: Object.fromEntries(this.config),
    };
    await this.vault.write(this.indexPath, JSON.stringify(data));
  }

  // ---- file states ----

  async upsertFileState(state: FileState): Promise<void> {
    await this.load();
    this.files.set(state.relative_path, { ...state });
    // A file state and a tombstone for the same path must never coexist: a
    // tombstone means "deleted", so recording the file again (a pull, a push
    // landing, or the file reappearing on disk) retires the tombstone.
    // Otherwise the stale tombstone re-deletes the file on the next session.
    this.tombstones.delete(state.relative_path);
    await this.persist();
  }

  async getFileState(path: string): Promise<FileState | null> {
    await this.load();
    const f = this.files.get(path);
    return f ? { ...f } : null;
  }

  async deleteFileState(path: string): Promise<void> {
    await this.load();
    this.files.delete(path);
    await this.persist();
  }

  async getAllFileStates(): Promise<FileState[]> {
    await this.load();
    return [...this.files.values()].map((f) => ({ ...f }));
  }

  async fileCount(): Promise<number> {
    await this.load();
    return this.files.size;
  }

  // ---- tombstones ----

  async upsertTombstone(tombstone: Tombstone): Promise<void> {
    await this.load();
    this.tombstones.set(tombstone.relative_path, { ...tombstone });
    await this.persist();
  }

  async getTombstones(): Promise<Tombstone[]> {
    await this.load();
    return [...this.tombstones.values()].map((t) => ({ ...t }));
  }

  // ---- config ----

  async setConfig(key: string, value: string): Promise<void> {
    await this.load();
    this.config.set(key, value);
    await this.persist();
  }

  async getConfig(key: string): Promise<string | null> {
    await this.load();
    return this.config.get(key) ?? null;
  }

  // ---- conflicts ----

  async recordConflict(
    relativePath: string,
    localHash: Uint8Array | null,
    remoteHash: Uint8Array | null
  ): Promise<void> {
    await this.load();
    this.conflicts = this.conflicts.filter(
      (c) => !(c.relative_path === relativePath && !c.resolved)
    );
    this.conflicts.push({
      id: this.nextConflictId++,
      relative_path: relativePath,
      local_hash: localHash,
      remote_hash: remoteHash,
      local_revision: null,
      remote_revision: null,
      detected_at: Date.now(),
      resolved: false,
    });
    await this.persist();
  }

  async getUnresolvedConflicts(): Promise<ConflictEntry[]> {
    await this.load();
    return this.conflicts
      .filter((c) => !c.resolved)
      .sort((a, b) => b.detected_at - a.detected_at)
      .map((c) => ({ ...c }));
  }

  async markConflictResolved(id: number): Promise<void> {
    await this.load();
    const c = this.conflicts.find((x) => x.id === id);
    if (c) c.resolved = true;
    await this.persist();
  }

  // ---- devices ----

  async upsertDevice(device: DeviceIdentity): Promise<void> {
    await this.load();
    this.devices.set(device.device_id, { ...device });
    await this.persist();
  }

  async getDevices(): Promise<DeviceIdentity[]> {
    await this.load();
    return [...this.devices.values()].map((d) => ({ ...d, public_key: new Uint8Array(d.public_key) }));
  }
}
