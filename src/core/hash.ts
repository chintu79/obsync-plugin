import { blake3 } from "@noble/hashes/blake3";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

/**
 * Content-addressing wrapper. The Rust `core` uses blake3 for file content
 * hashes. `@noble/hashes` provides standard blake2, not blake3's tree mode, but
 * its single-chunk output is identical for small files and we do not store the
 * hash on disk across language boundaries — it is only used in-memory for a
 * sync session. Hash framing is therefore self-consistent between peers that
 * both use the plugin. For the Rust reference path (NAS), this plugin build is
 * not the peer — the Rust server remains the source of mutual compatibility.
 */
export type ContentHash = Uint8Array; // 32 bytes

export function contentHash(data: Uint8Array | string): ContentHash {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return blake3(bytes);
}

export function contentHashHex(data: Uint8Array | string): string {
  return bytesToHex(contentHash(data));
}

export function sha256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return bytesToHex(sha256(bytes));
}