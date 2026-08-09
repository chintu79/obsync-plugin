import { MessageType, ProtocolMessage, newMessage, PROTOCOL_VERSION } from "./protocol";
import { NetworkError } from "./errors";

export const DEFAULT_PORT = 42042;
export const RPC_PATH = "/rpc";

/**
 * Make a user-entered server URL usable: trim whitespace, drop any trailing
 * slash, and add `http://` when the user omitted the scheme (a common
 * paste-into-the-field mistake — e.g. "10.174.223.140:42042"). Without a
 * scheme, requestUrl throws "Failed to fetch"-style errors.
 */
export function normalizeServerUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return url;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  return url.replace(/\/+$/, "");
}

/**
 * The one network hop in the plugin path. The Rust engine uses a persistent
 * TCP socket with length-prefixed bincode frames; mobile Obsidian plugins can
 * only do HTTP (`requestUrl`), so each protocol message is a POST request whose
 * response body is the next message. The message set (Hello/Manifest/
 * FileRequest/FileChunk/SyncOperation/...) is unchanged — only framing is.
 */
export interface HttpTransport {
  exchange(msg: ProtocolMessage): Promise<ProtocolMessage>;
  close(): Promise<void>;
}

/** Serialize a protocol message for the wire (JSON). */
export function encodeMessage(msg: ProtocolMessage): string {
  return JSON.stringify(msg);
}

/** Parse a response body, validating the protocol version. */
export function decodeMessage(body: string): ProtocolMessage {
  let msg: ProtocolMessage;
  try {
    msg = JSON.parse(body);
  } catch (e) {
    throw NetworkError.protocol(`invalid JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (typeof msg.version !== "number" || msg.version !== PROTOCOL_VERSION) {
    throw NetworkError.protocol(`protocol version mismatch: got ${msg.version}`);
  }
  return msg;
}

function exchangeTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(NetworkError.timeout()), ms));
}

/**
 * HTTP client transport. `post` is injected so the same class runs in Node
 * (global fetch, tests) and in Obsidian (mobile `requestUrl`, desktop via
 * `requestUrl`/`require('http')`). We never assume the ambient `fetch` exists
 * on Capacitor.
 */
export class HttpClientTransport implements HttpTransport {
  constructor(
    private url: string,
    private post: (url: string, body: string) => Promise<string>,
    private timeoutMs = 15000
  ) {}

  static forNode(url: string, timeoutMs?: number): HttpClientTransport {
    return new HttpClientTransport(url, async (u, body) => {
      const resp = await fetch(u, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!resp.ok) {
        const detail = (await resp.text().catch(() => "")).slice(0, 300);
        throw NetworkError.connection(`HTTP ${resp.status}${detail ? `: ${detail}` : ""}`);
      }
      return resp.text();
    }, timeoutMs);
  }

  async exchange(msg: ProtocolMessage): Promise<ProtocolMessage> {
    const body = encodeMessage(msg);
    const result = await Promise.race([
      this.post(this.url, body),
      exchangeTimeout(this.timeoutMs),
    ]);
    return decodeMessage(result);
  }

  async close(): Promise<void> {}
}

/**
 * Obsidian's `requestUrl` transport — the mobile path. Capacitor exposes only
 * `requestUrl`, which the plugin imports via `requestUrl` from "obsidian".
 * `requestUrl` is available on both desktop and mobile; on desktop the plugin
 * can also use Node `fetch`/`http`, but on mobile this is the only option.
 */
export class RequestUrlTransport implements HttpTransport {
  constructor(
    private url: string,
    private requestUrlFn: (param: {
      url: string;
      method: string;
      contentType?: string;
      body?: string | ArrayBuffer;
      headers?: Record<string, string>;
      throw: boolean;
    }) => Promise<{ status: number; text: string; arrayBuffer: ArrayBuffer }>,
    private timeoutMs = 15000
  ) {}

  async exchange(msg: ProtocolMessage): Promise<ProtocolMessage> {
    const body = encodeMessage(msg);
    const result = await Promise.race([
      (async () => {
        const resp = await this.requestUrlFn({
          url: this.url,
          method: "POST",
          contentType: "application/json",
          body,
          headers: {},
          throw: false,
        });
        if (resp.status >= 400) {
          const detail = (resp.text ?? "").slice(0, 300);
          throw NetworkError.connection(`HTTP ${resp.status}${detail ? `: ${detail}` : ""}`);
        }
        return resp.text;
      })(),
      exchangeTimeout(this.timeoutMs),
    ]);
    return decodeMessage(result);
  }

  async close(): Promise<void> {}
}

export interface ServerRequestContext {
  remoteAddress: string;
}

export type MessageHandler = (
  msg: ProtocolMessage,
  ctx: ServerRequestContext
) => Promise<ProtocolMessage>;

export interface HttpServerHandle {
  port: number;
  close(): Promise<void>;
}

/**
 * Minimal HTTP server for the desktop plugin (Node `require('http')`), the
 * counterpart of `obsync-local-rest-api`'s approach. Each POST to /rpc is one
 * protocol message; the handler's response is the reply. Implemented on raw
 * `http` (not Express) to keep dependencies at zero for the plugin path.
 *
 * Uses a lazy `require("http")` (not dynamic `import`): Obsidian's renderer
 * resolves ES dynamic imports as URLs, so `await import("node:http")` fails
 * with "Failed to fetch dynamically imported module". `require` is Node-only
 * and only ever evaluated on desktop (startRpcServer is never called on
 * mobile), matching the obsidian-local-rest-api precedent.
 */
export async function startRpcServer(
  handler: MessageHandler,
  port: number = DEFAULT_PORT
): Promise<HttpServerHandle> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require("http") as typeof import("http");
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== RPC_PATH) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const msg = decodeMessage(body);
        const ctx: ServerRequestContext = { remoteAddress: req.socket.remoteAddress ?? "" };
        const reply = await handler(msg, ctx);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(encodeMessage(reply));
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`internal error: ${err}`);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve());
  });
  const actual = (server.address() as { port: number }).port;

  return {
    port: actual,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function pingMessage(): ProtocolMessage {
  return newMessage("ping", 0, {});
}

export function disconnectMessage(): ProtocolMessage {
  return newMessage("disconnect", 0, {});
}
