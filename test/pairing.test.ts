import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeVaultAdapter } from "../src/core/node-adapter";
import { Store } from "../src/core/store";
import { SyncEngine } from "../src/core/engine";
import { SyncServer, runClientSession } from "../src/core/session";
import { PairingClient, PairingServer } from "../src/core/pairing";
import { DeviceIdentity } from "../src/core/identity";
import {
  HttpClientTransport,
  RequestUrlTransport,
  startRpcServer,
  RPC_PATH,
  HttpServerHandle,
} from "../src/core/transport";
import { newMessage } from "../src/core/protocol";

interface Vault {
  root: string;
  adapter: NodeVaultAdapter;
  engine: SyncEngine;
}

async function makeVault(deviceId: string, files: Record<string, string>): Promise<Vault> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `obsync-pair-${deviceId}-`));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const adapter = new NodeVaultAdapter(root);
  const engine = new SyncEngine(adapter, new Store(adapter), deviceId);
  await engine.init();
  await engine.initialIndex();
  return { root, adapter, engine };
}

/** A requestUrl-shaped function backed by node fetch, to mimic the mobile API. */
function requestUrlLike(baseUrl: string) {
  return async (param: {
    url: string;
    method: string;
    contentType?: string;
    body?: string | ArrayBuffer;
    throw: boolean;
  }) => {
    const resp = await fetch(baseUrl, {
      method: param.method,
      headers: { "Content-Type": param.contentType ?? "application/json" },
      body: param.body,
    });
    return { status: resp.status, text: await resp.text(), arrayBuffer: new ArrayBuffer(0) };
  };
}

let serverVault: Vault;
let server: HttpServerHandle | null = null;
let url = "";
let pairingServer: PairingServer;
let serverIdentity: DeviceIdentity;
let mobileIdentity: DeviceIdentity;

beforeAll(async () => {
  serverIdentity = DeviceIdentity.generate("Desktop");
  mobileIdentity = DeviceIdentity.generate("Mobile");
});

async function reset() {
  await server?.close();
  serverVault = await makeVault("server", {
    "notes/hello.md": "# Hello from server",
  });
  const syncServer = new SyncServer(serverVault.engine, serverVault.adapter);
  pairingServer = new PairingServer(serverVault.adapter, serverIdentity, syncServer);
  server = await startRpcServer((msg) => pairingServer.handle(msg), 0);
  url = `http://127.0.0.1:${server.port}${RPC_PATH}`;
}

beforeEach(reset);

afterAll(async () => {
  await server?.close();
});

describe("pairing", () => {
  it("rejects a sync from an unapproved device", async () => {
    const client = HttpClientTransport.forNode(url);
    const pair = new PairingClient(mobileIdentity);
    const reply = await client.exchange(
      newMessage("pair_request", 1, pair.buildPairRequest())
    );
    expect(reply.message_type).toBe("pair_ack");
    expect((reply.payload as { approved: boolean }).approved).toBe(false);
    expect((reply.payload as { server_public_key: string }).server_public_key).toBeTruthy();
  });

  it("pair_request shows up as pending until the desktop approves (real flow)", async () => {
    const pair = new PairingClient(mobileIdentity);
    const client = HttpClientTransport.forNode(url);

    // 1. Phone taps Sync now → pair_request → rejected but recorded as pending.
    const reply = await client.exchange(
      newMessage("pair_request", 2, pair.buildPairRequest())
    );
    expect((reply.payload as { approved: boolean }).approved).toBe(false);

    // 2. Desktop settings tab reads the pending request.
    const pending = await pairingServer.pendingDevices();
    expect(pending.map((p) => p.device_id)).toContain(mobileIdentity.device_id);

    // 3. Desktop clicks Approve.
    await pairingServer.approveDevice(pending.find((p) => p.device_id === mobileIdentity.device_id)!);

    // 4. Phone's next pair_request is approved, then sync succeeds.
    const reply2 = await client.exchange(
      newMessage("pair_request", 3, pair.buildPairRequest())
    );
    expect((reply2.payload as { approved: boolean }).approved).toBe(true);
    expect(await pairingServer.pendingDevices()).toEqual([]);

    const clientVault = await makeVault(mobileIdentity.device_id, {});
    const report = await runClientSession(clientVault.engine, client, {
      device_id: mobileIdentity.device_id,
      device_name: mobileIdentity.device_name,
    });
    expect(report.pulled_files).toBe(1);
  });

  it("approves a device, persists approval, and then syncs over the RPC server", async () => {
    const pair = new PairingClient(mobileIdentity);
    const req = pair.buildPairRequest();

    // Approve out-of-band (the desktop UI would call this after a prompt).
    await pairingServer.approveDevice(req);

    // Approved devices survive a server restart (persisted to .obsync/approved.json).
    const pairing2 = new PairingServer(
      serverVault.adapter,
      serverIdentity,
      new SyncServer(serverVault.engine, serverVault.adapter)
    );
    await pairing2.loadApproved();
    expect((await pairing2.approvedList()).map((d) => d.device_id)).toContain(
      mobileIdentity.device_id
    );

    // Now a full client session is allowed.
    const clientVault = await makeVault(mobileIdentity.device_id, {});
    const client = HttpClientTransport.forNode(url);
    const report = await runClientSession(clientVault.engine, client, {
      device_id: mobileIdentity.device_id,
      device_name: mobileIdentity.device_name,
    });
    expect(report.pulled_files).toBe(1);
  });

  it("RequestUrlTransport performs the same exchange (mobile transport shape)", async () => {
    const transport = new RequestUrlTransport(url, requestUrlLike(url), 15000);
    const pair = new PairingClient(mobileIdentity);

    // Not approved yet → rejected.
    let reply = await transport.exchange(
      newMessage("pair_request", 2, pair.buildPairRequest())
    );
    expect((reply.payload as { approved: boolean }).approved).toBe(false);

    // Approve, then the pair handshake approves.
    await pairingServer.approveDevice(pair.buildPairRequest());
    reply = await transport.exchange(
      newMessage("pair_request", 3, pair.buildPairRequest())
    );
    expect((reply.payload as { approved: boolean }).approved).toBe(true);

    // Full mobile-style sync: additive refresh, client session.
    const mobileVault = await makeVault(mobileIdentity.device_id, {
      "notes/mine.md": "created on phone",
    });
    await mobileVault.engine.refreshIndex(false);
    const report = await runClientSession(mobileVault.engine, transport);
    // Pulled the server's hello.md AND pushed the phone's mine.md.
    expect(report.pulled_files).toBeGreaterThanOrEqual(1);
    expect(report.pushed_files).toBeGreaterThanOrEqual(1);
    // The phone now has the server file on disk.
    const pulled = fs.readFileSync(
      path.join(mobileVault.root, "notes/hello.md"),
      "utf8"
    );
    expect(pulled).toBe("# Hello from server");
  });

  it("runClientSession throws for an unapproved device (hello gate)", async () => {
    // No approval: the hello handshake must be refused.
    const client = HttpClientTransport.forNode(url);
    const clientVault = await makeVault("unapproved-client", {});
    await expect(
      runClientSession(clientVault.engine, client, {
        device_id: "unapproved-client",
        device_name: "Mobile",
      })
    ).rejects.toThrow(/not approved/);
  });
});
