import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeVaultAdapter } from "../src/core/node-adapter";
import { Store } from "../src/core/store";
import { SyncEngine } from "../src/core/engine";
import { SyncServer, runClientSession } from "../src/core/session";
import {
  HttpClientTransport,
  startRpcServer,
  RPC_PATH,
  HttpServerHandle,
} from "../src/core/transport";
import { newMessage } from "../src/core/protocol";
import {
  Scope,
  allows,
  everythingScope,
  isEverything,
  mergeScopes,
  parseScope,
} from "../src/core/scope";

describe("scope model", () => {
  it("empty scope allows everything", () => {
    const s = everythingScope();
    expect(isEverything(s)).toBe(true);
    expect(allows(s, "any/path.md")).toBe(true);
  });

  it("folder entry covers the folder and its children", () => {
    const s: Scope = { entries: [{ kind: "folder", path: "notes" }], excludes: [] };
    expect(isEverything(s)).toBe(false);
    expect(allows(s, "notes")).toBe(true);
    expect(allows(s, "notes/a.md")).toBe(true);
    expect(allows(s, "notes/sub/b.md")).toBe(true);
    expect(allows(s, "other/a.md")).toBe(false);
    // prefix must respect path boundaries
    expect(allows(s, "notes-archive/a.md")).toBe(false);
  });

  it("exclusion wins over a folder include", () => {
    const s: Scope = {
      entries: [{ kind: "folder", path: "notes" }],
      excludes: ["notes/secret.md"],
    };
    expect(allows(s, "notes/a.md")).toBe(true);
    expect(allows(s, "notes/secret.md")).toBe(false);
  });

  it("exclusion-only scope is not 'everything'", () => {
    const s: Scope = { entries: [], excludes: ["a.md"] };
    expect(isEverything(s)).toBe(false);
    expect(allows(s, "b.md")).toBe(true);
    expect(allows(s, "a.md")).toBe(false);
  });

  it("exclusion matches exact paths only", () => {
    const s: Scope = { entries: [], excludes: ["notes/secret.md"] };
    expect(allows(s, "notes/secret.md.bak")).toBe(true);
    expect(allows(s, "other/notes/secret.md")).toBe(true);
  });

  it("normalizes backslashes when matching", () => {
    const s: Scope = { entries: [], excludes: ["notes/secret.md"] };
    expect(allows(s, "notes\\secret.md")).toBe(false);
  });

  it("merge unions entries and excludes", () => {
    const m = mergeScopes(
      { entries: [{ kind: "folder", path: "a" }], excludes: ["x.md"] },
      { entries: [{ kind: "file", path: "b.md" }, { kind: "folder", path: "a" }], excludes: ["x.md", "y.md"] }
    );
    expect(m.entries).toEqual([
      { kind: "folder", path: "a" },
      { kind: "file", path: "b.md" },
    ]);
    expect(m.excludes).toEqual(["x.md", "y.md"]);
    expect(allows(m, "a/f.md")).toBe(true);
    expect(allows(m, "y.md")).toBe(false);
  });

  it("parseScope tolerates missing or junk fields (pre-exclusion data)", () => {
    expect(parseScope(undefined)).toEqual(everythingScope());
    expect(parseScope({})).toEqual(everythingScope());
    expect(parseScope({ entries: "junk", excludes: 42 })).toEqual(everythingScope());
    const parsed = parseScope({
      entries: [{ kind: "file", path: "a\\b.md" }, { kind: "nope", path: "c.md" }, null],
      excludes: ["x.md", 7, "y.md"],
    });
    expect(parsed.entries).toEqual([{ kind: "file", path: "a/b.md" }]);
    expect(parsed.excludes).toEqual(["x.md", "y.md"]);
  });
});

// ---------------------------------------------------------------------------
// Session-level behavior over real HTTP, mirroring core/src/sync/peer.rs tests.
// ---------------------------------------------------------------------------

interface Vault {
  root: string;
  adapter: NodeVaultAdapter;
  store: Store;
  engine: SyncEngine;
}

async function makeVault(deviceId: string, files: Record<string, string>): Promise<Vault> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `obsync-scope-${deviceId}-`));
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

const SERVER_FILES = {
  "notes/hello.md": "# Hello from server",
  "notes/ideas.md": "server idea",
  "notes/secret.md": "server secret",
};

let serverVault: Vault;
let server: HttpServerHandle | null = null;
let url = "";
let serverScope: Scope = everythingScope();

async function startServer(getScope?: () => Scope) {
  await server?.close();
  serverVault = await makeVault("server", SERVER_FILES);
  const syncServer = new SyncServer(serverVault.engine, serverVault.adapter, getScope);
  server = await startRpcServer((msg) => syncServer.handle(msg), 0);
  url = `http://127.0.0.1:${server.port}${RPC_PATH}`;
}

beforeAll(async () => {
  server = null;
});

afterAll(async () => {
  await server?.close();
});

function clientExcluding(...paths: string[]): Scope {
  return { entries: [], excludes: paths };
}

describe("per-file sync selection over the wire", () => {
  beforeEach(async () => {
    serverScope = everythingScope();
    await startServer(() => serverScope);
  });

  it("client exclusion never pulls the excluded file", async () => {
    const client = await makeVault("client", {});
    const report = await runClientSession(
      client.engine,
      HttpClientTransport.forNode(url),
      undefined,
      clientExcluding("notes/secret.md")
    );
    expect(report.pulled_files).toBe(2);
    expect(fs.existsSync(path.join(client.root, "notes/secret.md"))).toBe(false);
    expect(fs.readFileSync(path.join(client.root, "notes/hello.md"), "utf8")).toBe(
      "# Hello from server"
    );
  });

  it("re-including resumes syncing without side effects", async () => {
    const client = await makeVault("client", {});
    const t = HttpClientTransport.forNode(url);
    await runClientSession(client.engine, t, undefined, clientExcluding("notes/secret.md"));
    expect(fs.existsSync(path.join(client.root, "notes/secret.md"))).toBe(false);

    // Second session with the exclusion lifted: the file arrives normally.
    const report = await runClientSession(client.engine, t, undefined, everythingScope());
    expect(report.pulled_files).toBe(1);
    expect(fs.readFileSync(path.join(client.root, "notes/secret.md"), "utf8")).toBe(
      "server secret"
    );
  });

  it("client exclusion ignores a server tombstone for that path", async () => {
    // Server deletes secret.md after the client already has a copy.
    await serverVault.engine.applyOperation({ op: "delete", path: "notes/secret.md" });

    const client = await makeVault("client", { "notes/secret.md": "server secret" });
    const report = await runClientSession(
      client.engine,
      HttpClientTransport.forNode(url),
      undefined,
      clientExcluding("notes/secret.md")
    );
    expect(report.deleted_files).toBe(0);
    expect(fs.readFileSync(path.join(client.root, "notes/secret.md"), "utf8")).toBe(
      "server secret"
    );
  });

  it("scoped server hides excluded files and refuses out-of-scope pushes", async () => {
    serverScope = clientExcluding("notes/secret.md");

    // Manifest omits the excluded file entirely.
    const client = await makeVault("client", {});
    let report = await runClientSession(client.engine, HttpClientTransport.forNode(url));
    expect(report.pulled_files).toBe(2);
    expect(fs.existsSync(path.join(client.root, "notes/secret.md"))).toBe(false);

    // Client somehow has the excluded file (e.g. exclusion added later):
    // the push attempt is refused and nothing lands on the server.
    fs.writeFileSync(path.join(client.root, "notes/secret.md"), "local secret");
    await client.engine.refreshIndex(false);
    report = await runClientSession(client.engine, HttpClientTransport.forNode(url));
    // The push is attempted and counted (the client never reads push acks,
    // same as the Rust TCP client) — but the server refuses it.
    expect(report.pushed_files).toBe(1);
    // The refused push must not overwrite the server's own copy.
    expect(fs.readFileSync(path.join(serverVault.root, "notes/secret.md"), "utf8")).toBe(
      "server secret"
    );

    // Direct out-of-scope file_request is nacked too.
    const syncServer = new SyncServer(serverVault.engine, serverVault.adapter, () => serverScope);
    const reply = await syncServer.handle(
      newMessage(
        "file_request",
        99,
        { relative_path: "notes/secret.md", content_hash: "", offset: 0 }
      )
    );
    expect(reply.message_type).toBe("operation_ack");
    expect((reply.payload as { ok: boolean }).ok).toBe(false);
  });
});
