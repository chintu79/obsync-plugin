import { describe, expect, it } from "vitest";
import { shouldIgnore } from "../src/core/ignore";

describe("shouldIgnore", () => {
  it("ignores hidden dotfiles", () => {
    expect(shouldIgnore(".hidden.md")).toBe(true);
  });

  it("does not ignore .obsidian dir", () => {
    expect(shouldIgnore(".obsidian/config")).toBe(false);
    expect(shouldIgnore(".obsidian/plugins/plugin/main.js")).toBe(false);
  });

  it("ignores editor swap files", () => {
    expect(shouldIgnore("notes.md.swp")).toBe(true);
    expect(shouldIgnore("notes.md.swx")).toBe(true);
  });

  it("ignores temp files", () => {
    expect(shouldIgnore("notes.md.tmp")).toBe(true);
    expect(shouldIgnore("notes.md.bak")).toBe(true);
    expect(shouldIgnore("notes.md~")).toBe(true);
  });

  it("ignores DS_Store and thumbs.db", () => {
    expect(shouldIgnore(".DS_Store")).toBe(true);
    expect(shouldIgnore("thumbs.db")).toBe(true);
  });

  it("keeps normal files", () => {
    expect(shouldIgnore("notes.md")).toBe(false);
    expect(shouldIgnore("project.md")).toBe(false);
    expect(shouldIgnore("image.png")).toBe(false);
    expect(shouldIgnore("notes/ideas.md")).toBe(false);
  });

  it("ignores sync-temp", () => {
    expect(shouldIgnore(".notes.md.sync-temp")).toBe(true);
    expect(shouldIgnore("notes.md.sync-temp")).toBe(true);
  });
});
