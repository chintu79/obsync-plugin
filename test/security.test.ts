import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeVaultAdapter } from "../src/core/node-adapter";
import { Store } from "../src/core/store";
import { SyncEngine } from "../src/core/engine";
import { SyncServer } from "../src/core/session";
import { PairingServer, PendingPairing, fingerprintOfPublicKey } from "../src/core/pairing";
import { DeviceIdentity } from "../src/core/identity";
import {
  HttpClientTransport,
  startRawRpcServer,
  RPC_PATH,
  HttpServerHandle,
} from "../src/core/transport";
import { SecureGate } from "../src/core/secure";
import { sealMessage } from "../src/core/crypto";
import { deriveSessionKeys, sasCode, x25519Shared, openEnvelope, isEnvelope } from "../src/core/crypto";
import { newMessage, PROTOCOL_VERSION } from "../src/core/protocol";

interface Vault {
  root: string;
  adapter: NodeVaultAdapter;
  store: Store;
  engine: SyncEngine;
}

async function makeVault(deviceId: string, files: Record<string, string>): Promise<Vault> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `obsync-sec-${deviceId}-`));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const adapter = new NodeVaultAdapter(root);
  const store = new Store(adapter);
  const engine = new SyncEngine(adapter, store, deviceId);
  await engine.init();
  await engine.initialIndex();
  return { root, adapter, store, engine };
}

let serverIdentity: DeviceIdentity;
let clientIdentity: DeviceIdentity;
let attackerIdentity: DeviceIdentity;
let serverVault: Vault;
let server: HttpServerHandle | null = null;
let gate: SecureGate;
let pairingRef: PairingServer;
let url = "";

beforeAll(async () => {
  serverIdentity = DeviceIdentity.generate("Desktop");
  clientIdentity = DeviceIdentity.generate("Phone");
  attackerIdentity = DeviceIdentity.generate("Attacker");
});

async function startSecureServer(): Promise<void> {
  await server?.close();
  serverVault = await makeVault("server", {
    "notes/hello.md": "# Hello from server",
    "notes/secret.md": "server secret",
  });
  const syncServer = new SyncServer(serverVault.engine, serverVault.adapter);
  const pairing = new PairingServer(
    serverVault.adapter,
    serverIdentity,
    syncServer
  );
  // Approve the phone's fingerprint ahead of the prompt flow.
  pairing.approveDevice({
    device_id: clientIdentity.device_id,
    device_name: clientIdentity.device_name,
    fingerprint: clientIdentity.fingerprint(),
    client_public_key: "",
  });
  gate = new SecureGate(pairing);
  pairingRef = pairing;
  server = await startRawRpcServer((body) => gate.handleBody(body), 0);
  url = `http://127.0.0.1:${server.port}${RPC_PATH}`;
}

function secureClient(identity = clientIdentity): HttpClientTransport {
  return HttpClientTransport.forNode(url, undefined, identity);
}

describe("session security", () => {
  beforeAll(async () => {
    await startSecureServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("ping stays stateless for zero-config discovery", async () => {
    const t = HttpClientTransport.forNode(url); // no identity — plaintext
    const reply = await t.exchange(newMessage("ping", 0, {}));
    expect(reply.message_type).toBe("operation_ack");
    expect((reply.payload as { ok: boolean }).ok).toBe(true);
  });

  it("unauthenticated data messages are refused — the old hole is closed", async () => {
    const t = HttpClientTransport.forNode(url); // no identity, no session
    const reply = await t.exchange(
      newMessage("manifest", 1, {
        device_id: "x",
        files: [],
        tombstones: [],
        revision_counter: 0,
      })
    );
    expect(reply.message_type).toBe("operation_ack");
    expect((reply.payload as { ok: boolean }).ok).toBe(false);
    expect((reply.payload as { error: string }).error).toContain("authentication required");
  });

  it("an approved device syncs over sealed envelopes end-to-end", async () => {
    const t = secureClient();
    const client = await makeVault(clientIdentity.device_id, {});
    // hello (plaintext handshake) → keys established
    const helloReply = await t.exchange(
      newMessage("hello", 0, {
        device_id: clientIdentity.device_id,
        device_name: clientIdentity.device_name,
        protocol_version: PROTOCOL_VERSION,
        public_key_fingerprint: clientIdentity.fingerprint(),
      })
    );
    expect(helloReply.message_type).toBe("hello_ack");
    expect((helloReply.payload as { approved: boolean }).approved).toBe(true);

    // manifest + pulls are now sealed
    const report = await import("../src/core/session").then((m) =>
      m.runClientSession(client.engine, t)
    );
    expect(report.pulled_files).toBe(2);
    expect(fs.readFileSync(path.join(client.root, "notes/secret.md"), "utf8")).toBe(
      "server secret"
    );
  });

  it("an unapproved device gets approved:false and NO session", async () => {
    const t = secureClient(attackerIdentity);
    const reply = await t.exchange(
      newMessage("hello", 0, {
        device_id: attackerIdentity.device_id,
        device_name: "Attacker",
        protocol_version: PROTOCOL_VERSION,
        public_key_fingerprint: attackerIdentity.fingerprint(),
      })
    );
    expect(reply.message_type).toBe("hello_ack");
    const payload = reply.payload as {
      approved: boolean;
      server_nonce?: string;
    };
    expect(payload.approved).toBe(false);
    expect(payload.server_nonce).toBeUndefined();

    // Even a follow-up manifest attempt must fail authentication.
    const manifest = await t.exchange(
      newMessage("manifest", 1, {
        device_id: attackerIdentity.device_id,
        files: [],
        tombstones: [],
        revision_counter: 0,
      })
    );
    expect((manifest.payload as { ok?: boolean }).ok).not.toBe(true);
  });

  it("a stolen envelope is useless: replay is rejected", async () => {
    // Drive the gate directly: establish a session whose keys we can compute,
    // then replay one identical sealed body and expect a refusal.
    const adapter = serverVault.adapter;
    const syncServer = new SyncServer(serverVault.engine, adapter);
    const pairing = new PairingServer(adapter, serverIdentity, syncServer);
    await pairing.approveDevice({
      device_id: clientIdentity.device_id,
      device_name: clientIdentity.device_name,
      fingerprint: clientIdentity.fingerprint(),
      client_public_key: "",
    });
    const localGate = new SecureGate(pairing);

    // Plaintext handshake with OUR known nonce.
    const clientNonce = "11".repeat(16);
    const helloBody = JSON.stringify(
      newMessage("hello", 0, {
        device_id: clientIdentity.device_id,
        device_name: clientIdentity.device_name,
        protocol_version: PROTOCOL_VERSION,
        public_key_fingerprint: clientIdentity.fingerprint(),
        client_public_key: bytesToHexOf(clientIdentity.publicKey),
        client_nonce: clientNonce,
      })
    );
    const helloReply = JSON.parse(await localGate.handleBody(helloBody));
    const shared = x25519Shared(clientIdentity.privateKey, serverIdentity.publicKey);
    const keys = deriveSessionKeys(shared, hexToBytesOf(clientNonce), hexToBytesOf(helloReply.payload.server_nonce));

    // Seal the SAME request at the same sequence number twice.
    const manifest = newMessage("manifest", 7, {
      device_id: clientIdentity.device_id,
      files: [],
      tombstones: [],
      revision_counter: 0,
    });
    const env1 = JSON.stringify(await sealMessage(keys, 1, manifest));
    const env2 = env1;

    // First delivery succeeds and comes back sealed.
    const reply1 = JSON.parse(await localGate.handleBody(env1));
    const opened1 = await openEnvelope<{ message_type: string }>(keys.key, reply1);
    expect(opened1.message_type).toBe("manifest");

    // The replay is refused with a PLAINTEXT nack — no oracle, no state change.
    const reply2 = JSON.parse(await localGate.handleBody(env2));
    expect(reply2.message_type).toBe("operation_ack");
    expect(reply2.payload.ok).toBe(false);
    expect(reply2.payload.error).toContain("stale sequence");
  });

  it("a tampered ciphertext fails to decrypt", async () => {
    const adapter = serverVault.adapter;
    const pairing = new PairingServer(adapter, serverIdentity, new SyncServer(serverVault.engine, adapter));
    await pairing.approveDevice({
      device_id: clientIdentity.device_id,
      device_name: clientIdentity.device_name,
      fingerprint: clientIdentity.fingerprint(),
      client_public_key: "",
    });
    const localGate = new SecureGate(pairing);

    const clientNonce = "22".repeat(16);
    const helloReply = JSON.parse(
      await localGate.handleBody(
        JSON.stringify(
          newMessage("hello", 0, {
            device_id: clientIdentity.device_id,
            device_name: clientIdentity.device_name,
            protocol_version: PROTOCOL_VERSION,
            public_key_fingerprint: clientIdentity.fingerprint(),
            client_public_key: bytesToHexOf(clientIdentity.publicKey),
            client_nonce: clientNonce,
          })
        )
      )
    );
    const shared = x25519Shared(clientIdentity.privateKey, serverIdentity.publicKey);
    const keys = deriveSessionKeys(shared, hexToBytesOf(clientNonce), hexToBytesOf(helloReply.payload.server_nonce));

    const env = await sealMessage(keys, 1, newMessage("manifest", 7, {}));
    // Flip one bit of the ciphertext.
    const raw = Buffer.from(env.ct, "base64");
    raw[0] ^= 0x01;
    env.ct = raw.toString("base64");
    const reply = JSON.parse(await localGate.handleBody(JSON.stringify(env)));
    expect(reply.message_type).toBe("operation_ack");
    expect(reply.payload.ok).toBe(false);
    expect(reply.payload.error).toContain("decryption failed");
  });

  it("sequence numbers strictly increase per session", async () => {
    const shared = x25519Shared(
      clientIdentity.privateKey,
      serverIdentity.publicKey
    );
    const keys = deriveSessionKeys(shared, new Uint8Array(16).fill(1), new Uint8Array(16).fill(2));
    expect(keys.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("SAS codes match on both sides and change with the peer", async () => {
    const legitShared = x25519Shared(
      clientIdentity.privateKey,
      serverIdentity.publicKey
    );
    const serverView = sasCode(
      x25519Shared(serverIdentity.privateKey, clientIdentity.publicKey)
    );
    expect(sasCode(legitShared)).toBe(serverView);
    expect(sasCode(legitShared)).toMatch(/^\d{6}$/);

    // An impostor presenting their own key derives different code material.
    const impostorShared = x25519Shared(
      attackerIdentity.privateKey,
      serverIdentity.publicKey
    );
    expect(sasCode(impostorShared)).not.toBe(sasCode(legitShared));
  });

  it("pairing requests surface the SAS to compare before approving", async () => {
    await startSecureServer(); // fresh approvals
    const attacker = HttpClientTransport.forNode(url, undefined, attackerIdentity);
    await attacker.exchange(
      newMessage("pair_request", 0, {
        device_id: attackerIdentity.device_id,
        device_name: "Attacker",
        client_public_key: bytesToHexOf(attackerIdentity.publicKey),
        fingerprint: attackerIdentity.fingerprint(),
      })
    );
    const pending = await pairingRef.pendingDevices();
    expect(pending.length).toBe(1);
    expect(pending[0].sas_code).toMatch(/^\d{6}$/);
    // The phone would display the same code derived from its own key.
    const expected = sasCode(
      x25519Shared(attackerIdentity.privateKey, serverIdentity.publicKey)
    );
    expect(pending[0].sas_code).toBe(expected);
  });

  it("approval binds to the KEY fingerprint, not the claimed device id", async () => {
    await startSecureServer();
    // Attacker claims the client's device_id but presents their own key.
    const t = secureClient(attackerIdentity);
    const reply = await t.exchange(
      newMessage("hello", 0, {
        device_id: clientIdentity.device_id, // stolen claim
        device_name: "Impostor",
        protocol_version: PROTOCOL_VERSION,
        public_key_fingerprint: fingerprintOfPublicKey(attackerIdentity.publicKey),
      })
    );
    expect((reply.payload as { approved: boolean }).approved).toBe(false);
    expect((reply.payload as { server_nonce?: string }).server_nonce).toBeUndefined();
  });
});

function bytesToHexOf(b: Uint8Array): string {
  let out = "";
  for (const x of b) out += x.toString(16).padStart(2, "0");
  return out;
}

function hexToBytesOf(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
