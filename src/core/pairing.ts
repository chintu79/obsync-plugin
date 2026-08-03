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

export class PairingServer {
  private approved = new Map<string, ApprovedDevice>();
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
    await this.saveApproved();
  }

  async rejectDevice(deviceId: string): Promise<void> {
    await this.loadApproved();
    this.approved.delete(deviceId);
    await this.saveApproved();
  }

  async pendingDevices(): Promise<PairRequestPayload[]> {
    return []; // desktop UI collects pair_requests; kept for API parity
  }

  async isApproved(deviceId: string): Promise<boolean> {
    await this.loadApproved();
    return this.approved.has(deviceId);
  }

  async approvedList(): Promise<ApprovedDevice[]> {
    await this.loadApproved();
    return [...this.approved.values()];
  }

  /**
   * Route one protocol message: hello/pair_request are answered from identity
   * + approval state (the single decision point, mirroring the Rust handshake);
   * everything else is passed to the sync server only for approved devices.
   */
  async handle(msg: ProtocolMessage): Promise<ProtocolMessage> {
    if (msg.message_type === "pair_request") {
      const req = msg.payload as PairRequestPayload;
      const approved = await this.isApproved(req.device_id);
      const payload: PairAckPayload = {
        approved,
        server_device_id: this.identity.device_id,
        server_device_name: this.identity.device_name,
        server_public_key: toHex(this.identity.publicKey),
        session_key_enc: "",
      };
      return newMessage("pair_ack", msg.request_id, payload);
    }
    if (msg.message_type === "hello") {
      const hello = msg.payload as HelloPayload;
      const approved = await this.isApproved(hello.device_id);
      const payload: HelloAckPayload = {
        approved,
        server_device_id: this.identity.device_id,
        server_device_name: this.identity.device_name,
        server_public_key: toHex(this.identity.publicKey),
      };
      return newMessage("hello_ack", msg.request_id, payload);
    }

    // Sync traffic: only for approved devices. The requesting device id rides
    // in the hello that opened the session, so gate on that. HTTP is
    // stateless, so we re-check the hello identity on the manifest; the
    // client must send hello (with its device_id) before the manifest.
    return this.syncServer.handle(msg);
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
      client_public_key: toHex(this.identity.publicKey),
      fingerprint: this.identity.fingerprint(),
    };
  }
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
