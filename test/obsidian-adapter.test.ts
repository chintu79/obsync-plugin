import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (p: string) => p,
}));

import { ObsidianVaultAdapter } from "../src/obsidian-adapter";

/**
 * The mobile pull path writes files into subfolders the phone may not have
 * yet. Obsidian's DataAdapter.writeBinary throws "Parent folder doesn't
 * exist" in that case — the adapter must create the parent first.
 */
function makeAdapter() {
  const dirs = new Set<string>();
  const files = new Map<string, ArrayBuffer>();
  const adapter = {
    exists: vi.fn(async (p: string) => dirs.has(p) || files.has(p)),
    mkdir: vi.fn(async (p: string) => {
      dirs.add(p);
    }),
    write: vi.fn(async (p: string, data: string) => {
      files.set(p, new TextEncoder().encode(data).buffer);
    }),
    writeBinary: vi.fn(async (p: string, data: ArrayBuffer) => {
      const idx = p.lastIndexOf("/");
      const parent = idx > 0 ? p.slice(0, idx) : "";
      if (parent && !dirs.has(parent)) {
        throw new Error("Parent folder doesn't exist");
      }
      files.set(p, data);
    }),
    read: vi.fn(async () => ""),
    readBinary: vi.fn(async () => new ArrayBuffer(0)),
    list: vi.fn(async () => ({ files: [], folders: [] })),
    stat: vi.fn(async () => null),
    remove: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
  };
  const vault = { adapter };
  return { adapter, vault, adapterImpl: new ObsidianVaultAdapter(vault as any) };
}

describe("ObsidianVaultAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the parent folder before writing into a missing subfolder", async () => {
    const { adapter, adapterImpl } = makeAdapter();
    await adapterImpl.write("notes/sub/a.md", new Uint8Array([1, 2, 3]));
    expect(adapter.writeBinary).toHaveBeenCalled();
    expect(adapter.mkdir).toHaveBeenCalledWith("notes/sub");
    expect(filesWritten(adapter)).toBe(1);
  });

  it("does not mkdir when the parent already exists", async () => {
    const { adapter, adapterImpl } = makeAdapter();
    await adapter.mkdir("existing");
    await adapterImpl.write("existing/a.md", new Uint8Array([1, 2, 3]));
    expect(adapter.mkdir).toHaveBeenCalledTimes(1); // only the pre-create
    expect(adapter.writeBinary).toHaveBeenCalledTimes(1);
  });

  it("leaves top-level files alone (no parent needed)", async () => {
    const { adapter, adapterImpl } = makeAdapter();
    await adapterImpl.write("root.md", new Uint8Array([1, 2, 3]));
    expect(adapter.mkdir).not.toHaveBeenCalled();
    expect(adapter.writeBinary).toHaveBeenCalledTimes(1);
  });
});

function filesWritten(adapter: { writeBinary: ReturnType<typeof vi.fn> }) {
  const calls = adapter.writeBinary.mock.calls as [string, ArrayBuffer][];
  return calls.length;
}
