/**
 * Session security primitives for the plugin sync protocol.
 *
 * Threat model: the server binds 0.0.0.0 on the LAN/hotspot, and discovery
 * hands out its address. Knowing the address must grant NOTHING: every data
 * message is authenticated and sealed with a key only the approved peer can
 * derive, and the first exchange is cross-verified with a short code.
 *
 * Design (static-static X25519 + HKDF + AES-256-GCM):
 *   shared = X25519(client_identity_priv, server_identity_pub)
 *   ok     = HKDF-SHA256(shared, salt = clientNonce || serverNonce,
 *                         info = "obsync-session-v1")   // 48 bytes
 *   key    = ok[0..32]      AES-256-GCM
 *   token  = hex(ok[32..48]) session handle (not secret-bearing by itself)
 *
 * Only the holder of the client's private key can derive `shared`, so a
 * sealed envelope IS the authentication — no password, no bearer token in
 * plaintext. A man-in-the-middle who swaps public keys during pairing is
 * caught by the SAS code (below), which both screens derive from `shared`.
 */

import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { gcm as wcGcm } from "@noble/ciphers/webcrypto";
import { gcm as nobleGcm } from "@noble/ciphers/aes";
import { NetworkError } from "./errors";

/** Nonce size for the standalone encrypt/decrypt helpers (Rust layout). */
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
  const cipher = nobleGcm(key, nonce);
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
    const cipher = nobleGcm(key, nonce);
    return cipher.decrypt(ciphertext);
  } catch (e) {
    throw NetworkError.encryption(
      e instanceof Error ? e.message : "authentication failed"
    );
  }
}

const SESSION_INFO = "obsync-session-v1";
const SAS_INFO = "obsync-sas-v1";

/** Random bytes from the platform CSPRNG (browser/Capacitor/Node 19+). */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function x25519Shared(
  myPrivate: Uint8Array,
  theirPublic: Uint8Array
): Uint8Array {
  return x25519.getSharedSecret(myPrivate, theirPublic);
}

export interface SessionKeys {
  /** AES-256-GCM content key. */
  key: Uint8Array;
  /** Opaque per-session handle carried on every envelope (hex). */
  token: string;
}

/** Derive session keys from the ECDH secret and both fresh nonces. */
export function deriveSessionKeys(
  shared: Uint8Array,
  clientNonce: Uint8Array,
  serverNonce: Uint8Array
): SessionKeys {
  const salt = new Uint8Array(clientNonce.length + serverNonce.length);
  salt.set(clientNonce, 0);
  salt.set(serverNonce, clientNonce.length);
  const ok = hkdf(sha256, shared, salt, SESSION_INFO, 48);
  return { key: ok.slice(0, 32), token: bytesToHex(ok.slice(32)) };
}

/**
 * Short Authentication String for pairing: 6 digits derived symmetrically
 * from the ECDH secret. Shown on both devices; equal codes mean no one sat
 * between them during the first exchange. Bluetooth-style numeric compare,
 * no camera required.
 */
export function sasCode(shared: Uint8Array): string {
  const tag = hmac(sha256, shared, SAS_INFO);
  const n = ((tag[0] << 24) | (tag[1] << 16) | (tag[2] << 8) | tag[3]) >>> 0;
  return String(n % 1000000).padStart(6, "0");
}

/** Wire envelope for a sealed protocol message. */
export interface Envelope {
  v: 1;
  /** session token (hex) */
  t: string;
  /** strictly increasing sequence number */
  n: number;
  /** base64 IV */
  iv: string;
  /** base64 ciphertext (AES-256-GCM over the JSON message) */
  ct: string;
}

export function isEnvelope(body: unknown): body is Envelope {
  if (!body || typeof body !== "object") return false;
  const e = body as Partial<Envelope>;
  return (
    e.v === 1 &&
    typeof e.t === "string" &&
    typeof e.n === "number" &&
    typeof e.iv === "string" &&
    typeof e.ct === "string"
  );
}

function aadFor(token: string, seq: number): Uint8Array {
  return new TextEncoder().encode(`${token}:${seq}`);
}

/** Seal a JSON-serializable message into an envelope. */
export async function sealMessage(
  keys: SessionKeys,
  seq: number,
  msg: unknown
): Promise<Envelope> {
  const iv = randomBytes(12);
  const plaintext = new TextEncoder().encode(JSON.stringify(msg));
  const cip = wcGcm(keys.key, iv, aadFor(keys.token, seq));
  const ct = await cip.encrypt(plaintext);
  return { v: 1, t: keys.token, n: seq, iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

/** Open an envelope; throws when the tag, AAD, or token do not match. */
export async function openEnvelope<T = unknown>(
  key: Uint8Array,
  env: Envelope
): Promise<T> {
  const iv = b64ToBytes(env.iv);
  const ct = b64ToBytes(env.ct);
  const cip = wcGcm(key, iv, aadFor(env.t, env.n));
  const plain = await cip.decrypt(ct);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (const x of b) out += x.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!hex || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error("malformed hex field");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function b64ToBytes(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
