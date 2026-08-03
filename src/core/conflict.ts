import { Blake3Hash, FileState } from "./state";

/** How a path with different content on both sides should be resolved. */
export enum SideOutcome {
  /** Both sides edited within the window — leave untouched, surface to the user. */
  Conflict,
  /** Local side is (clearly) newer — push local. */
  LocalWins,
  /** Remote side is (clearly) newer — pull remote. */
  RemoteWins,
}

/**
 * Port of core/src/conflict/detector.rs::resolve_divergence.
 *
 * Revisions are per-engine local counters incremented on any edit, so a file
 * that was ever edited on both devices has `revision > 0` on both sides
 * forever. A hash difference alone therefore does NOT prove a genuine conflict
 * — one side's content may simply be a later edit of the other's.
 *
 * The authoritative signal is `synced_hash`: the content hash the last sync
 * agreed on. If one side still has exactly that content, it never changed since
 * the agreement, so the other side's version is simply newer (pull/push, never
 * a conflict). A conflict only exists when BOTH sides edited since the
 * agreement. When agreement info is missing (pre-migration rows), fall back to
 * comparing modification times — the newer side wins.
 *
 * THIS IS THE SINGLE DECISION POINT. It must not drift from the Rust original.
 */
export function resolveDivergence(local: FileState, remote: FileState): SideOutcome {
  if (equalHash(local.content_hash, remote.content_hash)) {
    return SideOutcome.RemoteWins; // caller should treat as no-op
  }
  const localUnchanged = local.synced_hash !== null && equalHash(local.synced_hash, local.content_hash);
  const remoteUnchanged = remote.synced_hash !== null && equalHash(remote.synced_hash, remote.content_hash);
  if (localUnchanged) {
    return SideOutcome.RemoteWins; // local never edited since agreement → take remote
  }
  if (remoteUnchanged) {
    return SideOutcome.LocalWins; // remote never edited since agreement → push local
  }
  if (local.synced_hash !== null && remote.synced_hash !== null) {
    return SideOutcome.Conflict;
  }
  // Pre-migration rows: no agreement recorded → newer mtime wins.
  return local.modified_at >= remote.modified_at ? SideOutcome.LocalWins : SideOutcome.RemoteWins;
}

export function equalHash(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
