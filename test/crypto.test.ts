import { describe, expect, it } from "vitest";
import { gcm } from "@noble/ciphers/aes";
import { bytesToHex } from "@noble/hashes/utils";
import { decrypt, encrypt, NONCE_SIZE } from "../src/core/crypto";
import { NetworkError } from "../src/core/errors";

function keyOf(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

describe("crypto", () => {
  it("encrypt/decrypt round-trip", () => {
    const key = keyOf(7);
    const data = new TextEncoder().encode("hello world, this is a secret message");
    const enc = encrypt(data, key);
    const dec = decrypt(enc, key);
    expect(new TextDecoder().decode(dec)).toBe("hello world, this is a secret message");
  });

  it("decrypt with wrong key fails", () => {
    const key1 = keyOf(1);
    const key2 = keyOf(2);
    const enc = encrypt(new TextEncoder().encode("secret"), key1);
    expect(() => decrypt(enc, key2)).toThrow();
  });

  it("produces different ciphertexts for same data (random nonce)", () => {
    const key = keyOf(3);
    const data = new TextEncoder().encode("same data");
    const a = encrypt(data, key);
    const b = encrypt(data, key);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it("output is nonce (12) + ciphertext", () => {
    const key = keyOf(5);
    const data = new TextEncoder().encode("abc");
    const enc = encrypt(data, key);
    expect(enc.length).toBe(NONCE_SIZE + data.length + 16); // tag
  });

  it("rejects short ciphertext", () => {
    expect(() => decrypt(new Uint8Array(4), keyOf(1))).toThrow();
    try {
      decrypt(new Uint8Array(4), keyOf(1));
    } catch (e) {
      expect((e as NetworkError).kind).toBe("encryption");
    }
  });

  it("known-answer: AES-256-GCM empty message (GCM spec vector)", () => {
    // GCM spec Appendix B: key=00..00, nonce=00..00, PT empty
    const key = new Uint8Array(32);
    const nonce = new Uint8Array(12);
    const cipher = gcm(key, nonce);
    const out = cipher.encrypt(new Uint8Array(0));
    // Tag for this vector is 530f8afbc74536b9a963b4f1c4cb738b
    expect(bytesToHex(out)).toBe("530f8afbc74536b9a963b4f1c4cb738b");
  });
});
