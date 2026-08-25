/**
 * Transport-level security for the plugin sync protocol.
 *
 * SecureGate (server side) wraps the PairingServer: everything except the
 * stateless discovery `ping` must arrive as a sealed envelope belonging to a
 * session that was established through an approved hello/pair handshake.
 * This closes the "know the address, own the vault" hole — before this gate,
 * manifest/file_request messages were served to ANY LAN peer unauthenticated.
 *
 * RpcSession (client side) mirrors it: it injects key-agreement fields into
 * the first exchange and seals every later message. Both transports compose
 * it, so session code never knows crypto exists.
 */

import { DeviceIdentity } from "./identity";
import {
  Envelope,
  SessionKeys,
  bytesToHex as bytesToHexOf,
  deriveSessionKeys,
  isEnvelope,
  openEnvelope,
  randomBytes,
  sealMessage,
  x25519Shared,
} from "./crypto";
import { ProtocolMessage, PROTOCOL_VERSION } from "./protocol";

/** Message types served without a session. */
const OPEN_TYPES = new Set<string>(["ping"]);

export interface IssuedSession {
  keys: SessionKeys;
  device_id: string;
}

/** Max concurrent sessions kept; the oldest is dropped when exceeded. */
const MAX_SESSIONS = 64;
/** Sessions expire after this long without traffic (ms). */
const SESSION_TTL_MS = 30 * 60 * 1000;

interface ServerSession extends IssuedSession {
  lastSeq: number;
  lastUsed: number;
}

function nack(requestId: number, error: string): ProtocolMessage {
  return {
    version: PROTOCOL_VERSION,
    message_type: "operation_ack",
    request_id: requestId,
    payload: { ok: false, error },
  };
}

export class SecureGate {
  private sessions = new Map<string, ServerSession>();

  constructor(
    /** The plaintext handler (PairingServer). May set `out.issued` on the
     *  handshake messages that establish a session. */
    private inner: {
      handle(
        msg: ProtocolMessage,
        out?: { issued?: IssuedSession }
      ): Promise<ProtocolMessage>;
    }
  ) {}

  /**
   * Entry point for one HTTP body. Accepts a plaintext ping, a plaintext
   * handshake (hello/pair_request), or a sealed envelope. Returns the JSON
   * body to respond with (plaintext for handshakes, sealed otherwise).
   */
  async handleBody(raw: string): Promise<string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return JSON.stringify(nack(0, "invalid JSON"));
    }

    if (isEnvelope(parsed)) return this.handleEnvelope(parsed);

    const msg = parsed as ProtocolMessage;
    if (!msg || typeof msg.message_type !== "string") {
      return JSON.stringify(nack(0, "invalid message"));
    }

    if (OPEN_TYPES.has(msg.message_type)) {
      const reply = await this.inner.handle(msg);
      return JSON.stringify(reply);
    }

    if (msg.message_type === "hello" || msg.message_type === "pair_request") {
      const out: { issued?: IssuedSession } = {};
      const reply = await this.inner.handle(msg, out);
      if (out.issued) this.remember(out.issued);
      // Plaintext by necessity: the client cannot hold the key before this
      // reply. Everything sensitive it triggers afterwards is sealed.
      return JSON.stringify(reply);
    }

    return JSON.stringify(nack(msg.request_id ?? 0, "authentication required"));
  }

  private async handleEnvelope(env: Envelope): Promise<string> {
    const sess = this.sessions.get(env.t);
    if (!sess) {
      return JSON.stringify(nack(env.n, "unknown session — say hello again"));
    }
    if (env.n <= sess.lastSeq) {
      return JSON.stringify(nack(env.n, "stale sequence number"));
    }
    let msg: ProtocolMessage;
    try {
      msg = await openEnvelope<ProtocolMessage>(sess.keys.key, env);
    } catch {
      // Wrong key, tampered AAD, or corrupt ciphertext — do not reveal which.
      return JSON.stringify(nack(env.n, "decryption failed"));
    }
    sess.lastSeq = env.n;
    sess.lastUsed = Date.now();

    const reply = await this.inner.handle(msg);
    const sealed = await sealMessage(sess.keys, env.n, reply);
    return JSON.stringify(sealed);
  }

  private remember(issued: IssuedSession): void {
    const now = Date.now();
    for (const [t, s] of this.sessions) {
      if (now - s.lastUsed > SESSION_TTL_MS) this.sessions.delete(t);
    }
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      this.sessions.delete(oldest[0]);
    }
    this.sessions.set(issued.keys.token, {
      ...issued,
      lastSeq: 0,
      lastUsed: now,
    });
  }

  dropAll(): void {
    this.sessions.clear();
  }
}

/**
 * Client-side session state shared by both transports. Attaches key-agreement
 * fields to the first hello/pair_request, derives keys from the reply, then
 * seals/unseals every subsequent exchange transparently.
 */
export class RpcSession {
  private keys: SessionKeys | null = null;
  private seq = 0;
  /** Nonce we sent on the most recent handshake; the server mixes it into
   *  the key derivation, so we must reuse the exact same bytes. */
  private clientNonce: Uint8Array | null = null;

  constructor(private identity: DeviceIdentity) {}

  /**
   * Mutate an outgoing message before it hits the wire. Handshake messages
   * gain the caller's public key + a fresh nonce; sealed messages become
   * envelopes. Returns the wire body.
   */
  async outgoing(msg: ProtocolMessage): Promise<string> {
    if (
      !this.keys &&
      (msg.message_type === "hello" || msg.message_type === "pair_request")
    ) {
      const payload = { ...(msg.payload as Record<string, unknown>) };
      payload.client_public_key = bytesToHexOf(this.identity.publicKey);
      this.clientNonce = randomBytes(16);
      payload.client_nonce = bytesToHexOf(this.clientNonce);
      msg = { ...msg, payload };
    }
    if (!this.keys) return JSON.stringify(msg);
    const env = await sealMessage(this.keys, ++this.seq, msg);
    return JSON.stringify(env);
  }

  /**
   * Parse a response body. Handshake replies arrive in plaintext and may
   * establish the session; later replies are envelopes.
   */
  async incoming(body: string): Promise<ProtocolMessage> {
    const parsed = JSON.parse(body) as unknown;
    if (!isEnvelope(parsed)) {
      this.maybeEstablish(parsed as ProtocolMessage);
      return stripWireFields(parsed as ProtocolMessage);
    }
    if (!this.keys) throw new Error("encrypted reply without a session");
    const msg = await openEnvelope<ProtocolMessage>(this.keys.key, parsed);
    return stripWireFields(msg);
  }

  /** Establish keys from a hello_ack / pair_ack that carries the server's
   *  nonce. Idempotent: the first establishment wins. */
  private maybeEstablish(reply: ProtocolMessage): void {
    if (this.keys || !this.clientNonce) return;
    if (
      !reply ||
      (reply.message_type !== "hello_ack" && reply.message_type !== "pair_ack")
    ) {
      return;
    }
    const p = reply.payload as {
      approved?: boolean;
      server_public_key?: string;
      server_nonce?: string;
    };
    if (!p?.approved || !p.server_public_key || !p.server_nonce) return;
    const shared = x25519Shared(
      this.identity.privateKey,
      hexToBytesOf(p.server_public_key)
    );
    this.keys = deriveSessionKeys(
      shared,
      this.clientNonce,
      hexToBytesOf(p.server_nonce)
    );
  }
}

// Wire-only fields injected into handshake payloads are stripped after the
// round trip so typed payload consumers never see them.
function stripWireFields(msg: ProtocolMessage): ProtocolMessage {
  if (msg && typeof msg.payload === "object" && msg.payload !== null) {
    const p = { ...(msg.payload as Record<string, unknown>) };
    delete p.client_public_key;
    delete p.client_nonce;
    return { ...msg, payload: p };
  }
  return msg;
}

function hexToBytesOf(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
