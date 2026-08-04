export type RevisionId = number;

export const BLAKE3_LENGTH = 32;

export type Blake3Hash = Uint8Array; // 32 bytes

export enum SyncState {
  Synced = 0,
  PendingCreate = 1,
  PendingUpdate = 2,
  PendingDelete = 3,
  Conflict = 4,
}

export interface FileState {
  relative_path: string;
  content_hash: Blake3Hash;
  size: number;
  modified_at: number;
  revision: RevisionId;
  sync_state: SyncState;
  synced_hash: Blake3Hash | null;
}

export interface Tombstone {
  relative_path: string;
  revision: RevisionId;
  deleted_at: number;
  /**
   * The content hash the deleting side had last agreed on for this path
   * (the file state's synced_hash, falling back to its content_hash). A
   * tombstone only beats a remote file that still matches this hash — if the
   * remote changed the file after we last saw it, the edit wins and the file
   * is pulled back. Absent (pre-upgrade tombstones), callers fall back to a
   * deleted_at vs modified_at comparison.
   */
  agreed_hash: Blake3Hash | null;
}

export interface Manifest {
  device_id: string;
  files: FileState[];
  tombstones: Tombstone[];
  revision_counter: RevisionId;
}

export function newFileState(
  relative_path: string,
  content_hash: Blake3Hash,
  size: number,
  modified_at: number,
  revision: RevisionId
): FileState {
  return {
    relative_path,
    content_hash,
    size,
    modified_at,
    revision,
    sync_state: SyncState.Synced,
    synced_hash: null,
  };
}