import { gcm } from "@noble/ciphers/aes";
import { NetworkError } from "./errors";

export const NONCE_SIZE = 12;

/**
 * Encrypt data with AES-256-GCM. Output layout matches the Rust original
 * (`core/src/security/crypto.rs`): a random 12-byte nonce followed by the
 * ciphertext+tag. Uses `@noble/ciphers/aes` gcm (pure TS, no WebCrypto
 * dependency so it runs on mobile Capacitor).
 */
export function encrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== 32) throw NetworkError.encryption("key must be 32 bytes");
  const nonce = new Uint8Array(NONCE_SIZE);
  crypto.getRandomValues(nonce);
  const cipher = gcm(key, nonce);
  const ciphertext = cipher.encrypt(data);
  const result = new Uint8Array(NONCE_SIZE + ciphertext.length);
  result.set(nonce, 0);
  result.set(ciphertext, NONCE_SIZE);
  return result;
}

/**
 * Decrypt AES-256-GCM data produced by `encrypt`. Throws `NetworkError` on a
 * bad key or tampered ciphertext (GCM auth tag failure).
 */
export function decrypt(encrypted: Uint8Array, key: Uint8Array): Uint8Array {
  if (encrypted.length < NONCE_SIZE) {
    throw NetworkError.encryption("data too short");
  }
  const nonce = encrypted.slice(0, NONCE_SIZE);
  const ciphertext = encrypted.slice(NONCE_SIZE);
  try {
    const cipher = gcm(key, nonce);
    return cipher.decrypt(ciphertext);
  } catch (e) {
    throw NetworkError.encryption(
      e instanceof Error ? e.message : "authentication failed"
    );
  }
}
