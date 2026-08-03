import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeVaultAdapter } from "../src/core/node-adapter";
import { Store } from "../src/core/store";
import { SyncEngine } from "../src/core/engine";
import { SyncServer, runClientSession } from "../src/core/session";
import { HttpClientTransport, startRpcServer, RPC_PATH, HttpServerHandle } from "../src/core/transport";

interface Vault {
  root: string;
  adapter: NodeVaultAdapter;
  store: Store;
  engine: SyncEngine;
}

async function makeVault(deviceId: string, files: Record<string, string>): Promise<Vault> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `obsync-sync-${deviceId}-`));
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

let serverVault: Vault;
let server: HttpServerHandle | null = null;
let url = "";

beforeAll(async () => {
  server = null;
});

async function resetServerVault() {
  await server?.close();
  serverVault = await makeVault("server", {
    "notes/hello.md": "# Hello from server",
    "notes/ideas.md": "server idea",
  });
  const syncServer = new SyncServer(serverVault.engine, serverVault.adapter);
  server = await startRpcServer((msg) => syncServer.handle(msg), 0);
  url = `http://127.0.0.1:${server.port}${RPC_PATH}`;
}

beforeEach(async () => {
  await resetServerVault();
});

afterAll(async () => {
  await server?.close();
});

async function clientTransport() {
  return HttpClientTransport.forNode(url);
}

describe("desktop sync round-trip", () => {
  it("client pulls server files it lacks", async () => {
    const client = await makeVault("client", {});
    const report = await runClientSession(client.engine, await clientTransport());
    expect(report.pulled_files).toBe(2);
    expect(fs.readFileSync(path.join(client.root, "notes/hello.md"), "utf8")).toBe(
      "# Hello from server"
    );
    expect(fs.readFileSync(path.join(client.root, "notes/ideas.md"), "utf8")).toBe("server idea");
    // client index agrees with the pulled content
    const manifest = await client.engine.buildManifest();
    expect(manifest.files.length).toBe(2);
    expect(manifest.files.every((f) => f.synced_hash !== null)).toBe(true);
  });

  it("client pushes files only it has", async () => {
    const client = await makeVault("client", { "mynotes/private.md": "only on client" });
    const report = await runClientSession(client.engine, await clientTransport());
    expect(report.pushed_files).toBe(1);
    expect(fs.readFileSync(path.join(serverVault.root, "mynotes/private.md"), "utf8")).toBe(
      "only on client"
    );
  });

  it("server-then-client edit is an update, not a conflict", async () => {
    // server file agreed on first
    await makeVault("seed", {}); // ensure server state known
    const client = await makeVault("client", {});
    await runClientSession(client.engine, await clientTransport());

    // both edit: client first, sync (agreement), then server edits
    fs.writeFileSync(path.join(client.root, "notes/ideas.md"), "client edited idea");
    await client.engine.refreshIndex(false);
    await runClientSession(client.engine, await clientTransport());

    fs.writeFileSync(path.join(serverVault.root, "notes/ideas.md"), "server edited idea");
    await serverVault.engine.refreshIndex(true);

    // fresh client that has the agreement should pull server's newer edit
    const client2 = await makeVault("client2", {});
    await runClientSession(client2.engine, await clientTransport());
    expect(fs.readFileSync(path.join(client2.root, "notes/ideas.md"), "utf8")).toBe(
      "server edited idea"
    );
  });

  it("remote tombstone deletes local file", async () => {
    const client = await makeVault("client", {});
    await runClientSession(client.engine, await clientTransport());
    // server deletes one file
    fs.rmSync(path.join(serverVault.root, "notes/ideas.md"));
    await serverVault.engine.refreshIndex(true);

    await runClientSession(client.engine, await clientTransport());
    expect(fs.existsSync(path.join(client.root, "notes/ideas.md"))).toBe(false);
  });

  it("local tombstone pushes a deletion to the server", async () => {
    const client = await makeVault("client", {});
    await runClientSession(client.engine, await clientTransport());
    // An explicit delete on the client (e.g. via the plugin's UI) tombstones
    // the file; the next session pushes that tombstone to the server.
    await client.engine.applyOperation({ op: "delete", path: "notes/ideas.md" });
    await runClientSession(client.engine, await clientTransport());
    expect(fs.existsSync(path.join(serverVault.root, "notes/ideas.md"))).toBe(false);
  });
});
