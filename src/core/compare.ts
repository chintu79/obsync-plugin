import { equalHash } from "./conflict";
import { resolveDivergence, SideOutcome } from "./conflict";
import { FileState, Manifest, RevisionId, Tombstone } from "./state";
import { SyncOperation } from "./delta";

export interface ManifestDiff {
  operations: SyncOperation[];
  conflicts: [FileState, FileState][]; // [local, remote]
  remote_revision_counter: RevisionId;
}

function mapByPath<T>(items: T[], getPath: (item: T) => string): Map<string, T> {
  const m = new Map<string, T>();
  for (const item of items) m.set(getPath(item), item);
  return m;
}

/**
 * Port of core/src/index/compare.rs::compare_manifests. Produces sync
 * operations from two manifests using `resolve_divergence` for changed paths.
 */
export function compareManifests(local: Manifest, remote: Manifest): ManifestDiff {
  const localMap = mapByPath(local.files, (f) => f.relative_path);
  const remoteMap = mapByPath(remote.files, (f) => f.relative_path);
  const localTombstones = mapByPath(local.tombstones, (t) => t.relative_path);
  const remoteTombstones = mapByPath(remote.tombstones, (t) => t.relative_path);

  const operations: SyncOperation[] = [];
  const conflicts: [FileState, FileState][] = [];

  // Files in remote but not in local → create (unless locally tombstoned)
  for (const [path, remoteFile] of remoteMap) {
    if (!localMap.has(path) && !localTombstones.has(path)) {
      operations.push({ op: "create", path, ...contentOf(remoteFile) });
    }
  }

  // Files in local but not in remote → create (upload) (unless remotely tombstoned)
  for (const [path, localFile] of localMap) {
    if (!remoteMap.has(path) && !remoteTombstones.has(path)) {
      operations.push({ op: "create", path, ...contentOf(localFile) });
    }
  }

  // Files in both → compare hashes
  for (const [path, localFile] of localMap) {
    const remoteFile = remoteMap.get(path);
    if (remoteFile && !equalHash(localFile.content_hash, remoteFile.content_hash)) {
      switch (resolveDivergence(localFile, remoteFile)) {
        case SideOutcome.Conflict:
          conflicts.push([localFile, remoteFile]);
          break;
        case SideOutcome.LocalWins:
          operations.push({ op: "update", path, ...contentOf(localFile) });
          break;
        case SideOutcome.RemoteWins:
          operations.push({ op: "update", path, ...contentOf(remoteFile) });
          break;
      }
    }
  }

  // Tombstone handling: deleted on one side
  for (const path of localMap.keys()) {
    if (remoteTombstones.has(path)) {
      operations.push({ op: "delete", path });
    }
  }
  for (const path of remoteMap.keys()) {
    if (localTombstones.has(path)) {
      operations.push({ op: "delete", path });
    }
  }

  return {
    operations,
    conflicts,
    remote_revision_counter: remote.revision_counter,
  };
}

function contentOf(f: FileState): { content_hash: Uint8Array; size: number; modified_at: number } {
  return { content_hash: f.content_hash, size: f.size, modified_at: f.modified_at };
}