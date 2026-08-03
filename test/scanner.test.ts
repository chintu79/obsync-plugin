import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeVaultAdapter } from "../src/core/node-adapter";
import { scanVault, scanFile } from "../src/core/scanner";
import { contentHashHex } from "../src/core/hash";

const FIXTURE = path.join(__dirname, "fixtures", "vaultA");

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsync-scan-"));
  fs.cpSync(FIXTURE, root, { recursive: true });
  return { root, vault: new NodeVaultAdapter(root) };
}

describe("scanner", () => {
  it("indexes a sample vault matching the expected manifest", async () => {
    const { vault } = makeVault();
    const result = await scanVault(vault);

    // .hidden.md and notes/tmp.swp are ignored, but .obsidian/config.json is
    // allowed (Rust: test_not_ignore_obsidian_dir). expected.json lives outside
    // the vault fixture.
    const paths = result.files.map((f) => f.relative_path).sort();
    expect(paths).toEqual([
      ".obsidian/config.json",
      "attachments/notes.txt",
      "notes/ideas.md",
      "notes/welcome.md",
    ]);

    const byPath = new Map(result.files.map((f) => [f.relative_path, f]));
    expect(byPath.get("notes/welcome.md")!.size).toBe(37);
    expect(byPath.get("notes/ideas.md")!.size).toBe(31);
    expect(byPath.get("attachments/notes.txt")!.size).toBe(21);
    expect(byPath.get(".obsidian/config.json")!.size).toBe(2);

    // Cross-language conformance: these hex values are asserted in the Rust
    // core's `conformance` test against its own blake3, so equality here means
    // the TS port's manifest hashes equal the Rust engine's.
    expect(contentHashHex(await vault.readBinary("notes/welcome.md"))).toBe(
      "27577c8f12ca06b6ee4e0919e02a3422225284784b29009d55b2456eb98f483d"
    );
    expect(contentHashHex(await vault.readBinary("notes/ideas.md"))).toBe(
      "e667d66cb5f61fa437a6f0804462a182fb30e93694b1de87ff857de71e1498f0"
    );
    expect(contentHashHex(await vault.readBinary("attachments/notes.txt"))).toBe(
      "06ce4214a481357d8d73df8d0b50307ec93e88a538dbe359e0fb4b756d6b3ea7"
    );
  });

  it("assigns sequential revisions and reports the counter", async () => {
    const { vault } = makeVault();
    const result = await scanVault(vault);
    expect(result.files.length).toBe(4);
    for (const f of result.files) {
      expect(f.revision).toBeGreaterThan(0);
    }
    expect(result.revisionCounter).toBe(result.files.length);
    // revisions are 1..N in scan order
    expect(new Set(result.files.map((f) => f.revision)).size).toBe(4);
  });

  it("reuses hashes for unchanged files (incremental scan)", async () => {
    const { vault } = makeVault();
    const first = await scanVault(vault);
    const existing = new Map(
      first.files.map((f) => [
        f.relative_path,
        { size: f.size, modified_at: f.modified_at, content_hash: f.content_hash },
      ])
    );
    const second = await scanVault(vault, existing);
    expect(second.files.map((f) => f.content_hash)).toEqual(
      first.files.map((f) => f.content_hash)
    );
    expect(second.revisionCounter).toBe(4);
  });

  it("rehashes a file whose size changed", async () => {
    const { root, vault } = makeVault();
    const first = await scanVault(vault);
    const existing = new Map(
      first.files.map((f) => [
        f.relative_path,
        { size: f.size, modified_at: f.modified_at, content_hash: f.content_hash },
      ])
    );
    const changed = first.files.find((f) => f.relative_path === "notes/welcome.md")!;
    const oldHash = changed.content_hash;
    fs.appendFileSync(path.join(root, "notes/welcome.md"), " extra");
    const second = await scanVault(vault, existing);
    const newState = second.files.find((f) => f.relative_path === "notes/welcome.md")!;
    expect([...newState.content_hash]).not.toEqual([...oldHash]);
    expect(newState.size).toBeGreaterThan(changed.size);
  });

  it("scanFile returns a single state with revision 0", async () => {
    const { vault } = makeVault();
    const state = await scanFile(vault, "notes/welcome.md");
    expect(state.relative_path).toBe("notes/welcome.md");
    expect(state.revision).toBe(0);
    expect(state.size).toBe(37);
  });

  it("ignores files under the ignore list even when present", async () => {
    const { root, vault } = makeVault();
    fs.writeFileSync(path.join(root, ".DS_Store"), "dummy");
    fs.writeFileSync(path.join(root, "notes.md~"), "backup");
    const result = await scanVault(vault);
    expect(result.files.some((f) => f.relative_path.endsWith(".DS_Store"))).toBe(false);
    expect(result.files.some((f) => f.relative_path.endsWith("notes.md~"))).toBe(false);
  });
});
