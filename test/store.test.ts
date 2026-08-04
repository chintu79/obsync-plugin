import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeVaultAdapter } from "../src/core/node-adapter";
import { Store, INDEX_PATH } from "../src/core/store";
import { FileState, SyncState, Tombstone, newFileState } from "../src/core/state";

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsync-store-"));
  const vault = new NodeVaultAdapter(root);
  return { root, vault, store: new Store(vault) };
}

function testHash(): Uint8Array {
  return new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
}

describe("store", () => {
  it("upserts and retrieves a file state", async () => {
    const { store } = makeStore();
    const state = newFileState("notes/test.md", testHash(), 100, 1000, 1);
    await store.upsertFileState(state);
    const got = await store.getFileState("notes/test.md");
    expect(got?.relative_path).toBe("notes/test.md");
    expect([...got!.content_hash]).toEqual([...testHash()]);
    expect(got?.size).toBe(100);
  });

  it("counts files", async () => {
    const { store } = makeStore();
    expect(await store.fileCount()).toBe(0);
    await store.upsertFileState(newFileState("a.md", testHash(), 10, 1, 1));
    await store.upsertFileState(newFileState("b.md", testHash(), 10, 1, 2));
    expect(await store.fileCount()).toBe(2);
  });

  it("deletes a file state", async () => {
    const { store } = makeStore();
    await store.upsertFileState(newFileState("a.md", testHash(), 10, 1, 1));
    await store.deleteFileState("a.md");
    expect(await store.getFileState("a.md")).toBeNull();
  });

  it("tombstones", async () => {
    const { store } = makeStore();
    const t: Tombstone = { relative_path: "dead.md", revision: 5, deleted_at: 1000, agreed_hash: null };
    await store.upsertTombstone(t);
    const tombstones = await store.getTombstones();
    expect(tombstones.length).toBe(1);
    expect(tombstones[0].relative_path).toBe("dead.md");
  });

  it("config", async () => {
    const { store } = makeStore();
    await store.setConfig("vault_path", "/test/path");
    expect(await store.getConfig("vault_path")).toBe("/test/path");
    expect(await store.getConfig("nonexistent")).toBeNull();
  });

  it("persists across reloads", async () => {
    const { vault } = makeStore();
    const s1 = new Store(vault);
    const f = newFileState("notes/persist.md", testHash(), 55, 2000, 7);
    f.synced_hash = testHash();
    await s1.upsertFileState(f);
    await s1.upsertTombstone({ relative_path: "gone.md", revision: 2, deleted_at: 300, agreed_hash: null });
    await s1.recordConflict("c.md", testHash(), new Uint8Array(32).fill(1));

    const s2 = new Store(vault);
    const got = await s2.getFileState("notes/persist.md");
    expect(got?.size).toBe(55);
    expect([...got!.synced_hash!]).toEqual([...testHash()]);
    const tombs = await s2.getTombstones();
    expect(tombs.some((t) => t.relative_path === "gone.md")).toBe(true);
    const conflicts = await s2.getUnresolvedConflicts();
    expect(conflicts.some((c) => c.relative_path === "c.md")).toBe(true);
  });

  it("records and resolves conflicts, replacing unresolved for same path", async () => {
    const { store } = makeStore();
    await store.recordConflict("a.md", testHash(), new Uint8Array(32).fill(1));
    await store.recordConflict("a.md", testHash(), new Uint8Array(32).fill(2));
    let conflicts = await store.getUnresolvedConflicts();
    expect(conflicts.filter((c) => c.relative_path === "a.md").length).toBe(1);
    expect(conflicts[0].detected_at).toBeGreaterThan(0);

    await store.markConflictResolved(conflicts[0].id);
    conflicts = await store.getUnresolvedConflicts();
    expect(conflicts.length).toBe(0);
  });

  it("index.json lives under .obsync/", async () => {
    const { vault } = makeStore();
    const store = new Store(vault);
    await store.upsertFileState(newFileState("a.md", testHash(), 1, 1, 1));
    expect(await vault.exists(INDEX_PATH)).toBe(true);
  });

  it("handles a corrupt index gracefully", async () => {
    const { root, vault } = makeStore();
    fs.mkdirSync(path.join(root, ".obsync"), { recursive: true });
    fs.writeFileSync(path.join(root, INDEX_PATH), "not json{");
    const store = new Store(vault);
    expect(await store.fileCount()).toBe(0);
  });
});
