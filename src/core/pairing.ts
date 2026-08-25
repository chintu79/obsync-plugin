import { DeviceIdentity } from "./identity";
import {
  HelloPayload,
  HelloAckPayload,
  PairAckPayload,
  PairRequestPayload,
  ProtocolMessage,
  newMessage,
} from "./protocol";
import { SyncServer } from "./session";
import { VaultAdapter } from "./vault";
import type { IssuedSession } from "./secure";
import {
  bytesToHex,
  deriveSessionKeys,
  hexToBytes,
  randomBytes,
  sasCode,
  x25519Shared,
} from "./crypto";
import { sha256 } from "@noble/hashes/sha2";

/** Fingerprint (hex) of a raw public key — first 8 bytes of SHA-256. */
export function fingerprintOfPublicKey(publicKey: Uint8Array): string {
  return bytesToHex(sha256(publicKey).slice(0, 8));
}

/**
 * Desktop-side pairing + session gate. Wraps a SyncServer so that sync
 * messages (manifest/file_request/sync_operation) are only handled for devices
 * the user has approved. The approval set is loaded/saved through the vault
 * adapter as `.obsync/approved.json`.
 *
 * Flow (mirrors the Rust handshake + httpd approve prompt):
 *   mobile ── pair_request(fingerprint, device_name) ──> desktop
 *   desktop asks the user to approve; on approve,
 *   mobile <── pair_ack(approved, server identity) <── desktop
 *   mobile now runs runClientSession against the same endpoint.
 */

const APPROVED_PATH = ".obsync/approved.json";

interface ApprovedDevice {
  device_id: string;
  device_name: string;
  fingerprint: string;
  approved_at: number;
}

/** A pairing request awaiting approval, plus the verification code the user
 *  must compare against the phone screen. */
export interface PendingPairing extends PairRequestPayload {
  /** 6-digit Short Authentication String derived from the ECDH secret. */
  sas_code: string;
  requested_at: number;
}

export class PairingServer {
  private approved = new Map<string, ApprovedDevice>();
  private pending = new Map<string, PendingPairing>();
  private loaded = false;

  constructor(
    private vault: VaultAdapter,
    private identity: DeviceIdentity,
    private syncServer: SyncServer
  ) {}

  async loadApproved(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!(await this.vault.exists(APPROVED_PATH))) return;
    try {
      const raw = await this.vault.readText(APPROVED_PATH);
      const list = JSON.parse(raw) as ApprovedDevice[];
      for (const d of list) this.approved.set(d.device_id, d);
    } catch {
      // corrupt → start fresh
    }
  }

  private async saveApproved(): Promise<void> {
    await this.vault.write(
      APPROVED_PATH,
      JSON.stringify([...this.approved.values()])
    );
  }

  /** Approve a device the user clicked "approve" on. */
  async approveDevice(req: PairRequestPayload): Promise<void> {
    await this.loadApproved();
    this.approved.set(req.device_id, {
      device_id: req.device_id,
      device_name: req.device_name,
      fingerprint: req.fingerprint,
      approved_at: Date.now(),
    });
    this.pending.delete(req.device_id);
    await this.saveApproved();
  }

  async rejectDevice(deviceId: string): Promise<void> {
    await this.loadApproved();
    this.approved.delete(deviceId);
    this.pending.delete(deviceId);
    await this.saveApproved();
  }

  /** Devices that have requested pairing but are not approved yet. */
  async pendingDevices(): Promise<PendingPairing[]> {
    return [...this.pending.values()];
  }

  /**
   * Cryptographically bound approval check: the caller must present the
   * private key matching an approved fingerprint. Self-asserted device_ids
   * are never trusted on their own.
   */
  isApprovedFingerprint(fingerprint: string): boolean {
    if (fingerprint === this.identity.fingerprint()) return true; // self-sync
    for (const d of this.approved.values()) {
      if (d.fingerprint === fingerprint) return true;
    }
    return false;
  }

  async isApproved(deviceId: string): Promise<boolean> {
    // The local engine is its own client when the desktop "Sync now" runs
    // against 127.0.0.1 — never reject our own identity.
    if (deviceId === this.identity.device_id) return true;
    await this.loadApproved();
    return this.approved.has(deviceId);
  }

  async approvedList(): Promise<ApprovedDevice[]> {
    await this.loadApproved();
    return [...this.approved.values()];
  }

  /**
   * Route one protocol message. hello/pair_request verify the presented key
   * against approved fingerprints, derive the session keys, and (when
   * approved) hand them to the SecureGate via `out.issued`; everything else
   * is passed to the sync server — the gate only lets sealed messages
   * through, so this handler never sees unauthenticated sync traffic.
   */
  async handle(
    msg: ProtocolMessage,
    out?: { issued?: IssuedSession }
  ): Promise<ProtocolMessage> {
    if (msg.message_type === "pair_request") {
      return this.handlePairRequest(msg, out);
    }
    if (msg.message_type === "hello") {
      return this.handleHello(msg, out);
    }
    // Unreachable through the SecureGate; direct SyncServer use in tests.
    return this.syncServer.handle(msg);
  }

  private async handlePairRequest(
    msg: ProtocolMessage,
    out?: { issued?: IssuedSession }
  ): Promise<ProtocolMessage> {
    const req = msg.payload as PairRequestPayload;
    let clientPub: Uint8Array | null = null;
    try {
      clientPub = hexToBytes(req.client_public_key ?? "");
    } catch {
      clientPub = null;
    }
    if (!clientPub || clientPub.length !== 32) {
      return newMessage("operation_ack", msg.request_id, {
        ok: false,
        error: "pair_request requires a valid X25519 public key",
      });
    }

    const fingerprint = fingerprintOfPublicKey(clientPub);
    const approved = this.isApprovedFingerprint(fingerprint);
    if (!approved) {
      // Derive the SAS from the ECDH secret so BOTH screens can display it;
      // the user compares before clicking approve on the desktop.
      const shared = x25519Shared(this.identity.privateKey, clientPub);
      const sas = sasCode(shared);
      this.pending.set(req.device_id, {
        ...req,
        fingerprint,
        sas_code: sas,
        requested_at: Date.now(),
      });
    }
    const payload: PairAckPayload = {
      approved,
      server_device_id: this.identity.device_id,
      server_device_name: this.identity.device_name,
      server_public_key: bytesToHex(this.identity.publicKey),
      session_key_enc: "",
    };
    if (approved) {
      // Already-approved devices skip the SAS round trip and go straight to
      // a sealed session.
      const issued = this.establishSession(clientPub, req.device_id, req.client_nonce);
      if (issued) {
        payload.server_nonce = issued.serverNonce;
        out && (out.issued = issued.session);
      }
    }
    return newMessage("pair_ack", msg.request_id, payload);
  }

  private async handleHello(
    msg: ProtocolMessage,
    out?: { issued?: IssuedSession }
  ): Promise<ProtocolMessage> {
    const hello = msg.payload as HelloPayload & {
      client_public_key?: string;
      client_nonce?: string;
    };
    // Server is authoritative: refresh the index so files edited directly on
    // disk reach the client this session (matches the Rust engine).
    try {
      await this.syncServer.handle(msg);
    } catch (e) {
      console.warn(`obsync: hello refresh failed: ${e instanceof Error ? e.message : e}`);
    }

    let clientPub: Uint8Array | null = null;
    try {
      clientPub = hexToBytes(hello.client_public_key ?? "");
    } catch {
      clientPub = null;
    }
    const approved =
      clientPub && clientPub.length === 32
        ? this.isApprovedFingerprint(fingerprintOfPublicKey(clientPub))
        : await this.isApproved(hello.device_id);

    const payload: HelloAckPayload = {
      approved,
      server_device_id: this.identity.device_id,
      server_device_name: this.identity.device_name,
      server_public_key: bytesToHex(this.identity.publicKey),
    };
    if (approved && clientPub && clientPub.length === 32) {
      const issued = this.establishSession(
        clientPub,
        hello.device_id,
        hello.client_nonce
      );
      if (issued) {
        payload.server_nonce = issued.serverNonce;
        out && (out.issued = issued.session);
      }
    }
    return newMessage("hello_ack", msg.request_id, payload);
  }

  /**
   * Static-static X25519 between long-term identity keys + fresh nonces.
   * Only the holder of an approved private key can derive the same keys, so
   * possession of the session IS the authentication.
   */
  private establishSession(
    clientPub: Uint8Array,
    deviceId: string,
    clientNonceHex?: string
  ): { session: IssuedSession; serverNonce: string } | null {
    let clientNonce: Uint8Array;
    try {
      clientNonce = hexToBytes(clientNonceHex ?? "");
    } catch {
      return null;
    }
    if (clientNonce.length !== 16) return null;
    const shared = x25519Shared(this.identity.privateKey, clientPub);
    const serverNonce = randomBytes(16);
    const keys = deriveSessionKeys(shared, clientNonce, serverNonce);
    return {
      serverNonce: bytesToHex(serverNonce),
      session: { keys, device_id: deviceId },
    };
  }
}

/**
 * Mobile-side pairing client: send a pair_request and, if approved, the
 * caller proceeds to sync.
 */
export class PairingClient {
  constructor(private identity: DeviceIdentity) {}

  buildPairRequest(): PairRequestPayload {
    return {
      device_id: this.identity.device_id,
      device_name: this.identity.device_name,
      client_public_key: bytesToHex(this.identity.publicKey),
      fingerprint: this.identity.fingerprint(),
    };
  }

  /**
   * The SAS the phone should display for this server: derived from
   * ECDH(identity_priv, server_pub). Equal to the desktop's code iff no
   * man-in-the-middle sits between them.
   */
  verifyCodeFor(serverPublicKeyHex: string): string {
    const shared = x25519Shared(
      this.identity.privateKey,
      hexToBytes(serverPublicKeyHex)
    );
    return sasCode(shared);
  }
}
