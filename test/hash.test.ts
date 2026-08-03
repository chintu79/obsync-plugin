import { describe, expect, it } from "vitest";
import { contentHashHex, contentHash, sha256Hex } from "../src/core/hash";

describe("hash", () => {
  it("produces 32-byte blake3 hashes", () => {
    const h = contentHash("hello");
    expect(h.length).toBe(32);
    // blake3 of empty-string input; check hex known vector
  });

  it("is deterministic and string/bytes equivalent", () => {
    expect(contentHashHex("hello")).toBe(contentHashHex("hello"));
    expect(contentHashHex(new TextEncoder().encode("hello"))).toBe(
      contentHashHex("hello")
    );
  });

  it("differs across inputs", () => {
    expect(contentHashHex("a")).not.toBe(contentHashHex("b"));
  });

  it("blake3 reference vector", () => {
    // blake3("") = af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262
    expect(contentHashHex("")).toBe(
      "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
    );
  });

  it("sha256 reference vector", () => {
    // sha256("abc")
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});
