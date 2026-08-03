import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HttpClientTransport,
  startRpcServer,
  pingMessage,
  disconnectMessage,
  HttpServerHandle,
  encodeMessage,
  decodeMessage,
  RPC_PATH,
  normalizeServerUrl,
} from "../src/core/transport";
import { ProtocolMessage, newMessage } from "../src/core/protocol";

let server: HttpServerHandle | null = null;
let url = "";

beforeAll(async () => {
  const echoHandler = async (msg: ProtocolMessage) => {
    if (msg.message_type === "ping") {
      return newMessage("hello_ack", msg.request_id, {
        approved: true,
        server_device_id: "server-test",
        server_device_name: "Test Server",
        server_public_key: "deadbeef",
      });
    }
    if (msg.message_type === "disconnect") {
      return newMessage("operation_ack", msg.request_id, { ok: true });
    }
    // echo back with a marker so we can assert the payload round-trips
    return newMessage("operation_ack", msg.request_id, { ok: true, echoed: msg.payload });
  };
  server = await startRpcServer(echoHandler, 0);
  url = `http://127.0.0.1:${server.port}${RPC_PATH}`;
});

afterAll(async () => {
  await server?.close();
});

describe("transport", () => {
  it("server binds and reports its port", () => {
    expect(server!.port).toBeGreaterThan(0);
  });

  it("client exchanges a ping for a hello_ack", async () => {
    const client = HttpClientTransport.forNode(url);
    const reply = await client.exchange(pingMessage());
    expect(reply.message_type).toBe("hello_ack");
    expect((reply.payload as { approved: boolean }).approved).toBe(true);
  });

  it("payload round-trips through JSON framing", async () => {
    const client = HttpClientTransport.forNode(url);
    const msg = newMessage("file_request", 42, {
      relative_path: "notes/a.md",
      content_hash: "ab" + "00".repeat(31),
      offset: 0,
    });
    const reply = await client.exchange(msg);
    const echoed = (reply.payload as { echoed: unknown }).echoed as {
      relative_path: string;
      offset: number;
    };
    expect(echoed.relative_path).toBe("notes/a.md");
    expect(echoed.offset).toBe(0);
  });

  it("rejects a wrong protocol version", () => {
    const bad = { version: 99, message_type: "ping", request_id: 0, payload: {} };
    const text = encodeMessage(bad as ProtocolMessage);
    expect(() => decodeMessage(text)).toThrow(/version/);
  });

  it("disconnect returns ack", async () => {
    const client = HttpClientTransport.forNode(url);
    const reply = await client.exchange(disconnectMessage());
    expect(reply.message_type).toBe("operation_ack");
  });
});

describe("normalizeServerUrl", () => {
  it("adds http:// when the scheme is missing", () => {
    expect(normalizeServerUrl("10.174.223.140:42042")).toBe("http://10.174.223.140:42042");
  });

  it("keeps an explicit scheme", () => {
    expect(normalizeServerUrl("http://10.174.223.140:42042")).toBe("http://10.174.223.140:42042");
    expect(normalizeServerUrl("https://vault.example.com:8443")).toBe("https://vault.example.com:8443");
  });

  it("strips a trailing slash", () => {
    expect(normalizeServerUrl("10.174.223.140:42042/")).toBe("http://10.174.223.140:42042");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeServerUrl("  10.174.223.140:42042  ")).toBe("http://10.174.223.140:42042");
  });

  it("returns empty input unchanged", () => {
    expect(normalizeServerUrl("")).toBe("");
    expect(normalizeServerUrl("   ")).toBe("");
  });
});
