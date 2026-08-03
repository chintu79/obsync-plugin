import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeVaultAdapter } from "../src/core/node-adapter";
import {
  snapshotContent,
  listSnapshots,
  listAllSnapshots,
  restoreSnapshot,
  MAX_PER_FILE,
} from "../src/core/versioning";

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsync-test-"));
  const vault = new NodeVaultAdapter(root);
  return { root, vault };
}

describe("versioning", () => {
  it("snapshots round-trip and restore", async () => {
    const { vault } = makeVault();
    await vault.write("notes/idea.md", "v1");
    await snapshotContent(vault, "notes/idea.md", new TextEncoder().encode("v1"), 2);
    await vault.write("notes/idea.md", "v2");
    await snapshotContent(vault, "notes/idea.md", new TextEncoder().encode("v2"), 2);

    const snaps = await listSnapshots(vault, "notes/idea.md");
    expect(snaps.length).toBe(2);
    expect(snaps[0].relative_path).toBe("notes/idea.md");

    await restoreSnapshot(vault, "notes/idea.md", snaps[1].timestamp);
    expect(await vault.readText("notes/idea.md")).toBe("v1");
  });

  it("prunes to MAX_PER_FILE keeping newest", async () => {
    const { vault } = makeVault();
    await vault.write("notes/idea.md", "v0");
    for (let i = 0; i < MAX_PER_FILE + 10; i++) {
      const content = new TextEncoder().encode(`v${i}`);
      await vault.write("notes/idea.md", `v${i}`);
      await snapshotContent(vault, "notes/idea.md", content, content.length);
    }
    const snaps = await listSnapshots(vault, "notes/idea.md");
    expect(snaps.length).toBeLessThanOrEqual(MAX_PER_FILE);
  });

  it("restore of missing snapshot errors", async () => {
    const { vault } = makeVault();
    await expect(restoreSnapshot(vault, "x.md", 12345)).rejects.toThrow();
  });

  it("listAllSnapshots aggregates across files, newest first", async () => {
    const { vault } = makeVault();
    await vault.write("a.md", "a");
    await snapshotContent(vault, "a.md", new TextEncoder().encode("a"), 1);
    await vault.write("b/c.md", "bc");
    await snapshotContent(vault, "b/c.md", new TextEncoder().encode("bc"), 2);

    const all = await listAllSnapshots(vault);
    expect(all.length).toBe(2);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].timestamp).toBeGreaterThanOrEqual(all[i].timestamp);
    }
  });
});
