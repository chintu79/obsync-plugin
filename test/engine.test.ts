import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeVaultAdapter } from "../src/core/node-adapter";
import { Store } from "../src/core/store";
import { SyncEngine, SyncStateMachine, generateConflictPath } from "../src/core/engine";
import { Manifest, newFileState } from "../src/core/state";

function makeEngine(deviceId = "test-device") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsync-engine-"));
  const vault = new NodeVaultAdapter(root);
  const store = new Store(vault);
  const engine = new SyncEngine(vault, store, deviceId);
  return { root, vault, store, engine };
}

async function initEngine(engine: SyncEngine): Promise<void> {
  await engine.init();
}

describe("engine", () => {
  it("initial index on empty vault", async () => {
    const { engine } = makeEngine();
    await initEngine(engine);
    await engine.initialIndex();
    expect(await engine.fileCount()).toBe(0);
  });

  it("initial index with files", async () => {
    const { root, engine } = makeEngine();
    fs.writeFileSync(path.join(root, "a.md"), "hello");
    fs.writeFileSync(path.join(root, "b.md"), "world");
    await initEngine(engine);
    await engine.initialIndex();
    expect(await engine.fileCount()).toBe(2);
  });

  it("refresh_index detects new, modified and deleted", async () => {
    const { root, engine } = makeEngine();
    fs.writeFileSync(path.join(root, "keep.md"), "original keep");
    fs.writeFileSync(path.join(root, "change.md"), "original change");
    await initEngine(engine);
    await engine.initialIndex();
    expect(await engine.fileCount()).toBe(2);

    const before = await engine.buildManifest();
    const keepRev = before.files.find((f) => f.relative_path === "keep.md")!.revision;

    fs.writeFileSync(path.join(root, "change.md"), "changed content");
    fs.rmSync(path.join(root, "keep.md"));
    fs.writeFileSync(path.join(root, "new.md"), "brand new");

    await engine.refreshIndex(true);
    const manifest = await engine.buildManifest();
    expect(manifest.files.length).toBe(2);
    expect(manifest.files.some((f) => f.relative_path === "new.md")).toBe(true);
    expect(manifest.files.some((f) => f.relative_path === "change.md")).toBe(true);
    expect(manifest.tombstones.some((t) => t.relative_path === "keep.md")).toBe(true);

    const changeRev = manifest.files.find((f) => f.relative_path === "change.md")!.revision;
    expect(changeRev).toBeGreaterThan(keepRev);
  });

  it("refresh_index preserves revision of unchanged files", async () => {
    const { root, engine } = makeEngine();
    fs.writeFileSync(path.join(root, "stable.md"), "stable content");
    await initEngine(engine);
    await engine.initialIndex();
    const revBefore = (await engine.buildManifest()).files[0].revision;

    await engine.refreshIndex(true);
    const revAfter = (await engine.buildManifest()).files[0].revision;
    expect(revBefore).toBe(revAfter);
    expect(await engine.fileCount()).toBe(1);
  });

  it("refresh_index(false) does not tombstone phantom deletions", async () => {
    const { root, engine } = makeEngine();
    fs.writeFileSync(path.join(root, "ghost.md"), "content");
    await initEngine(engine);
    await engine.initialIndex();
    expect(await engine.fileCount()).toBe(1);

    fs.rmSync(path.join(root, "ghost.md"));
    await engine.refreshIndex(false);

    const manifest = await engine.buildManifest();
    expect(manifest.files.length).toBe(1);
    expect(manifest.tombstones.length).toBe(0);
  });

  it("refresh_index(true) tombstones deletions", async () => {
    const { root, engine } = makeEngine();
    fs.writeFileSync(path.join(root, "gone.md"), "content");
    await initEngine(engine);
    await engine.initialIndex();
    fs.rmSync(path.join(root, "gone.md"));

    await engine.refreshIndex(true);
    const manifest = await engine.buildManifest();
    expect(manifest.files.length).toBe(0);
    expect(manifest.tombstones.length).toBe(1);
    expect(manifest.tombstones[0].relative_path).toBe("gone.md");
  });

  it("builds a manifest", async () => {
    const { root, engine } = makeEngine("test-desk");
    fs.writeFileSync(path.join(root, "manifest.md"), "test");
    await initEngine(engine);
    await engine.initialIndex();
    const manifest = await engine.buildManifest();
    expect(manifest.device_id).toBe("test-desk");
    expect(manifest.files.length).toBe(1);
    expect(manifest.files[0].relative_path).toBe("manifest.md");
  });

  it("reconcile of identical manifest produces no ops", async () => {
    const { engine } = makeEngine();
    await initEngine(engine);
    await engine.initialIndex();
    const diff = await engine.reconcile(await engine.buildManifest());
    expect(diff.operations.length).toBe(0);
    expect(diff.conflicts.length).toBe(0);
  });

  it("reconcile with a new remote file produces a create op", async () => {
    const { engine } = makeEngine();
    await initEngine(engine);
    await engine.initialIndex();
    const remote: Manifest = {
      device_id: "remote",
      files: [newFileState("remote_file.md", new Uint8Array(32).fill(1), 100, 1000, 1)],
      tombstones: [],
      revision_counter: 1,
    };
    const diff = await engine.reconcile(remote);
    expect(diff.operations.length).toBe(1);
    expect(diff.operations[0].op).toBe("create");
  });

  it("state machine transitions", async () => {
    const { engine } = makeEngine();
    await initEngine(engine);
    expect(engine.stateMachine()).toBe(SyncStateMachine.Idle);
    engine.setState(SyncStateMachine.Syncing);
    expect(engine.stateMachine()).toBe(SyncStateMachine.Syncing);
    engine.setState(SyncStateMachine.Idle);
    expect(engine.stateMachine()).toBe(SyncStateMachine.Idle);
  });

  it("revision counter persists across reloads", async () => {
    const { root, vault, store, engine } = makeEngine();
    fs.writeFileSync(path.join(root, "a.md"), "hello");
    await initEngine(engine);
    await engine.initialIndex();

    const engine2 = new SyncEngine(vault, store, "test-device");
    await initEngine(engine2);
    const m = await engine2.buildManifest();
    expect(m.revision_counter).toBe(1);
    expect(m.files[0].revision).toBe(1);
  });

  it("generates conflict copy paths like Rust", () => {
    expect(generateConflictPath("notes/idea.md", "pixel")).toBe("notes/idea.conflict-pixel.md");
    expect(generateConflictPath("notes/README", "desktop")).toBe("notes/README.conflict-desktop");
  });
});
