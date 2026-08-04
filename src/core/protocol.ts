export const PROTOCOL_VERSION = 1;

export type MessageType =
  | "hello"
  | "hello_ack"
  | "pair_request"
  | "pair_ack"
  | "manifest"
  | "file_request"
  | "file_chunk"
  | "sync_operation"
  | "operation_ack"
  | "ping"
  | "disconnect";

export interface ProtocolMessage {
  version: number;
  message_type: MessageType;
  request_id: number;
  payload: unknown; // JSON body (bincode in the Rust path)
}

export function newMessage(
  messageType: MessageType,
  requestId: number,
  payload: unknown
): ProtocolMessage {
  return { version: PROTOCOL_VERSION, message_type: messageType, request_id: requestId, payload };
}

export interface HelloPayload {
  device_id: string;
  device_name: string;
  protocol_version: number;
  public_key_fingerprint: string;
}

export interface HelloAckPayload {
  approved: boolean;
  server_device_id: string;
  server_device_name: string;
  /** X25519 server public key (hex) — Phase 3 pairs the key agreement. */
  server_public_key: string;
}

/** Mobile → desktop: request pairing (before any sync session). */
export interface PairRequestPayload {
  device_id: string;
  device_name: string;
  /** X25519 client public key (hex) for key agreement. */
  client_public_key: string;
  fingerprint: string;
}

/** Desktop → mobile: pairing approved or rejected. */
export interface PairAckPayload {
  approved: boolean;
  server_device_id: string;
  server_device_name: string;
  server_public_key: string;
  /** Established AES-256-GCM session key, encrypted to the client's public key
   * (hex). Empty until Phase 3's key agreement is wired. */
  session_key_enc: string;
}

export interface FileRequestPayload {
  relative_path: string;
  content_hash: string; // hex
  offset: number;
}

export interface FileChunkPayload {
  relative_path: string;
  offset: number;
  data_b64: string; // base64 chunk
  is_last: boolean;
}

export interface SyncOperationPayload {
  operation_type: 0 | 1 | 2 | 3; // 0=create, 1=update, 2=delete, 3=rename
  relative_path: string;
  new_path?: string;
  content_hash?: string; // hex
  size: number;
  modified_at: number;
}

export interface OperationAckPayload {
  ok: boolean;
  error?: string;
  /** For create/update: the path the content actually landed at (may be a
   * conflict copy). */
  landed_path?: string;
}

export interface ManifestEnvelope {
  manifest: string; // JSON-serialized Manifest, hex? No — plain JSON in the plugin path
}

// ---- Manifest wire format ----
//
// Manifests cross the HTTP boundary as JSON. Uint8Array hashes don't survive
// JSON.stringify as bytes, so the wire format encodes each 32-byte hash as hex.
// This mirrors how the Rust path carries the manifest as a serde_json byte
// buffer over bincode.

export interface WireFileState {
  relative_path: string;
  content_hash: string; // hex (64 chars)
  size: number;
  modified_at: number;
  revision: number;
  sync_state: number;
  synced_hash: string | null;
}

export interface WireTombstone {
  relative_path: string;
  revision: number;
  deleted_at: number;
}

export interface WireManifest {
  device_id: string;
  files: WireFileState[];
  tombstones: WireTombstone[];
  revision_counter: number;
}

export function hashToHex(h: Uint8Array): string {
  let out = "";
  for (const b of h) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hashFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

import { FileState, Manifest, SyncState, Tombstone } from "./state";

/** Encode an in-memory Manifest (Uint8Array hashes) for the wire. */
export function manifestToWire(m: Manifest): WireManifest {
  return {
    device_id: m.device_id,
    files: m.files.map((f) => ({
      relative_path: f.relative_path,
      content_hash: hashToHex(f.content_hash),
      size: f.size,
      modified_at: f.modified_at,
      revision: f.revision,
      sync_state: f.sync_state as number,
      synced_hash: f.synced_hash ? hashToHex(f.synced_hash) : null,
    })),
    tombstones: m.tombstones.map((t) => ({
      relative_path: t.relative_path,
      revision: t.revision,
      deleted_at: t.deleted_at,
    })),
    revision_counter: m.revision_counter,
  };
}

/** Decode a wire Manifest back to in-memory form (Uint8Array hashes). */
export function manifestFromWire(w: WireManifest): Manifest {
  return {
    device_id: w.device_id,
    files: w.files.map((f) => ({
      relative_path: f.relative_path,
      content_hash: hashFromHex(f.content_hash),
      size: f.size,
      modified_at: f.modified_at,
      revision: f.revision,
      sync_state: f.sync_state as SyncState,
      synced_hash: f.synced_hash ? hashFromHex(f.synced_hash) : null,
    })),
    tombstones: w.tombstones.map((t) => ({
      relative_path: t.relative_path,
      revision: t.revision,
      deleted_at: t.deleted_at,
      agreed_hash: null,
    })),
    revision_counter: w.revision_counter,
  };
}
