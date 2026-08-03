import { describe, expect, it } from "vitest";
import { resolveDivergence, SideOutcome, equalHash } from "../src/core/conflict";
import { FileState, SyncState } from "../src/core/state";

function makeState(path: string, hashByte: number, rev: number, synced: number | null): FileState {
  const hash = new Uint8Array(32);
  hash[0] = hashByte;
  let syncedHash: Uint8Array | null = null;
  if (synced !== null) {
    const sh = new Uint8Array(32);
    sh[0] = synced;
    syncedHash = sh;
  }
  return {
    relative_path: path,
    content_hash: hash,
    size: 100,
    modified_at: rev,
    revision: rev,
    sync_state: SyncState.Synced,
    synced_hash: syncedHash,
  };
}

describe("resolveDivergence", () => {
  it("sequential edit on local → push (LocalWins)", () => {
    const local = makeState("a.md", 2, 3, 1);
    const remote = makeState("a.md", 1, 2, 1);
    expect(resolveDivergence(local, remote)).toBe(SideOutcome.LocalWins);
  });

  it("sequential edit on remote → pull (RemoteWins)", () => {
    const local = makeState("a.md", 1, 2, 1);
    const remote = makeState("a.md", 2, 3, 1);
    expect(resolveDivergence(local, remote)).toBe(SideOutcome.RemoteWins);
  });

  it("both edited since agreement → genuine conflict", () => {
    const local = makeState("a.md", 1, 3, 0);
    const remote = makeState("a.md", 2, 2, 0);
    expect(resolveDivergence(local, remote)).toBe(SideOutcome.Conflict);
  });

  it("same hash is a no-op regardless of revisions", () => {
    const local = makeState("a.md", 1, 3, 1);
    const remote = makeState("a.md", 1, 2, 0);
    expect(resolveDivergence(local, remote)).toBe(SideOutcome.RemoteWins);
  });

  it("no agreement (pre-v2) falls back to newer mtime", () => {
    const local = makeState("a.md", 1, 3, null);
    const remote = makeState("a.md", 2, 1, null);
    local.modified_at = 23 * 3600 * 1000;
    remote.modified_at = 21 * 3600 * 1000;
    expect(resolveDivergence(local, remote)).toBe(SideOutcome.LocalWins);
    expect(resolveDivergence(remote, local)).toBe(SideOutcome.RemoteWins);
  });

  it("equalHash handles nulls", () => {
    expect(equalHash(null, null)).toBe(true);
    expect(equalHash(new Uint8Array(32), null)).toBe(false);
    expect(equalHash(null, new Uint8Array(32))).toBe(false);
  });
});
