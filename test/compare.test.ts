import { describe, expect, it } from "vitest";
import { compareManifests } from "../src/core/compare";
import { Manifest, SyncState, newFileState, Tombstone } from "../src/core/state";

function hash(b: number): Uint8Array {
  const h = new Uint8Array(32);
  h.fill(0);
  h[0] = b;
  return h;
}

function manifest(deviceId: string, rev: number): Manifest {
  return {
    device_id: deviceId,
    files: [],
    tombstones: [],
    revision_counter: rev,
  };
}

describe("compareManifests", () => {
  it("creates files present only on remote", () => {
    const local = manifest("L", 1);
    const remote = manifest("R", 1);
    remote.files.push(newFileState("remote.md", hash(1), 10, 100, 1));
    const diff = compareManifests(local, remote);
    expect(diff.operations.some((o) => o.op === "create" && o.path === "remote.md")).toBe(true);
  });

  it("uploads files present only on local", () => {
    const local = manifest("L", 1);
    const remote = manifest("R", 1);
    local.files.push(newFileState("local.md", hash(1), 10, 100, 1));
    const diff = compareManifests(local, remote);
    expect(diff.operations.some((o) => o.op === "create" && o.path === "local.md")).toBe(true);
  });

  it("flags genuine conflicts and emits no op for them", () => {
    const local = manifest("L", 2);
    const remote = manifest("R", 2);
    const f1 = newFileState("both.md", hash(1), 10, 100, 1);
    f1.synced_hash = hash(0);
    const f2 = newFileState("both.md", hash(2), 10, 100, 1);
    f2.synced_hash = hash(0);
    local.files.push(f1);
    remote.files.push(f2);
    const diff = compareManifests(local, remote);
    expect(diff.conflicts.length).toBe(1);
    expect(diff.operations.filter((o) => o.path === "both.md")).toEqual([]);
  });

  it("propagates local edit when remote unchanged since agreement", () => {
    const local = manifest("L", 2);
    const remote = manifest("R", 2);
    const f1 = newFileState("both.md", hash(2), 10, 200, 2);
    f1.synced_hash = hash(1);
    const f2 = newFileState("both.md", hash(1), 10, 100, 1);
    f2.synced_hash = hash(1);
    local.files.push(f1);
    remote.files.push(f2);
    const diff = compareManifests(local, remote);
    expect(diff.conflicts.length).toBe(0);
    expect(diff.operations.some((o) => o.op === "update" && o.path === "both.md")).toBe(true);
  });

  it("deletes when other side tombstoned", () => {
    const local = manifest("L", 2);
    const remote = manifest("R", 2);
    local.files.push(newFileState("gone.md", hash(1), 10, 100, 1));
    const t: Tombstone = { relative_path: "gone.md", revision: 2, deleted_at: 300 };
    remote.tombstones.push(t);
    const diff = compareManifests(local, remote);
    expect(diff.operations.some((o) => o.op === "delete" && o.path === "gone.md")).toBe(true);
  });

  it("surfaces remote_revision_counter", () => {
    const local = manifest("L", 5);
    const remote = manifest("R", 9);
    expect(compareManifests(local, remote).remote_revision_counter).toBe(9);
  });
});
