import { describe, expect, it } from "vitest";
import {
  LAN_SUBNETS,
  discoverServer,
  lanCandidates,
  lanHosts,
  localCandidates,
  obsidianProbe,
  type ServerProbe,
} from "../src/core/discovery";
import { encodeMessage } from "../src/core/transport";
import { newMessage } from "../src/core/protocol";

function scriptedProbe(hits: string[]): { probe: ServerProbe; calls: string[] } {
  const calls: string[] = [];
  const probe: ServerProbe = async (url) => {
    calls.push(url);
    return hits.includes(url);
  };
  return { probe, calls };
}

describe("candidate generation", () => {
  it("tries 127.0.0.1 before localhost on the configured port", () => {
    expect(localCandidates(42042)).toEqual([
      "http://127.0.0.1:42042",
      "http://localhost:42042",
    ]);
    expect(localCandidates(9000)[0]).toBe("http://127.0.0.1:9000");
  });

  it("covers the common home subnets without network/broadcast addresses", () => {
    const hosts = lanHosts();
    expect(hosts.length).toBe(LAN_SUBNETS.length * 254);
    expect(hosts).toContain("192.168.1.1");
    expect(hosts).toContain("10.0.0.254");
    expect(hosts).not.toContain("192.168.1.0");
    expect(hosts).not.toContain("192.168.1.255");
  });

  it("maps hosts to full URLs on the given port", () => {
    expect(lanCandidates(12345)[0]).toBe("http://192.168.0.1:12345");
  });
});

describe("discoverServer", () => {
  it("finds the server on localhost without touching the LAN", async () => {
    const { probe, calls } = scriptedProbe(["http://127.0.0.1:42042"]);
    const out = await discoverServer({ probe });
    expect(out).toEqual({ found: true, url: "http://127.0.0.1:42042", phase: "localhost" });
    expect(calls).toEqual(["http://127.0.0.1:42042"]);
  });

  it("moves on to the LAN scan when localhost is silent", async () => {
    const { probe, calls } = scriptedProbe(["http://192.168.1.42:42042"]);
    const out = await discoverServer({ probe });
    expect(out).toEqual({ found: true, url: "http://192.168.1.42:42042", phase: "lan" });
    // 2 local probes + every host in the batch that contained the hit (32/batch)
    expect(calls.length).toBe(2 + 10 * 32);
  });

  it("returns not-found after probing every candidate", async () => {
    const { probe, calls } = scriptedProbe([]);
    const out = await discoverServer({ probe, budgetMs: 60000 });
    expect(out.found).toBe(false);
    expect(out.phase).toBe("lan");
    expect(calls.length).toBe(2 + LAN_SUBNETS.length * 254);
  });

  it("stops as soon as one host in a batch answers", async () => {
    const { probe, calls } = scriptedProbe(["http://192.168.0.1:42042"]);
    const out = await discoverServer({ probe });
    // batch 0 (first 32 LAN hosts) probes concurrently; the hit is first in it
    expect(calls.length).toBe(2 + 32);
    expect(out.url).toBe("http://192.168.0.1:42042");
  });

  it("honors the discovery budget instead of scanning forever", async () => {
    const calls: string[] = [];
    const slowProbe: ServerProbe = async (url, timeoutMs) => {
      calls.push(url);
      await new Promise((res) => globalThis.setTimeout(res, timeoutMs));
      return false;
    };
    // localhost probes run at probeTimeoutMs (30ms each); the LAN budget
    // (100ms) survives those, dies in the first batch (hosts clamped to a
    // 200ms minimum), and the scan stops
    await discoverServer({ probe: slowProbe, budgetMs: 100, probeTimeoutMs: 30 });
    expect(calls.length).toBeGreaterThan(2); // the first batch fired
    expect(calls.length).toBeLessThan(2 + LAN_SUBNETS.length * 254); // but not all
  });

  it("skips the LAN scan when includeLan is false", async () => {
    const { probe, calls } = scriptedProbe([]);
    const out = await discoverServer({ probe, includeLan: false });
    expect(out.found).toBe(false);
    expect(calls.length).toBe(2);
  });
});

describe("obsidianProbe", () => {
  function fakeRequestUrl(handler: (url: string) => { status: number; text: string }) {
    return async (param: {
      url: string;
      method: string;
      contentType?: string;
      body?: string | ArrayBuffer;
      headers?: Record<string, string>;
      throw: boolean;
    }): Promise<{ status: number; text: string; arrayBuffer: ArrayBuffer }> => {
      const r = handler(param.url);
      return { ...r, arrayBuffer: new ArrayBuffer(0) };
    };
  }

  it("accepts a server that answers ping with ok", async () => {
    const probe = obsidianProbe(
      fakeRequestUrl(() => ({
        status: 200,
        text: encodeMessage(newMessage("operation_ack", 0, { ok: true })),
      }))
    );
    expect(await probe("http://192.168.1.5:42042", 500)).toBe(true);
  });

  it("rejects a different service on the port", async () => {
    const probe = obsidianProbe(
      fakeRequestUrl(() => ({ status: 200, text: "hello from something else" }))
    );
    expect(await probe("http://192.168.1.5:42042", 500)).toBe(false);
  });

  it("rejects a protocol version mismatch", async () => {
    const probe = obsidianProbe(
      fakeRequestUrl(() => ({
        status: 200,
        text: encodeMessage({ version: 99, message_type: "operation_ack", request_id: 0, payload: { ok: true } }),
      }))
    );
    expect(await probe("http://192.168.1.5:42042", 500)).toBe(false);
  });

  it("rejects HTTP errors and network failures", async () => {
    const errProbe = obsidianProbe(
      fakeRequestUrl(() => ({ status: 500, text: "boom" }))
    );
    expect(await errProbe("http://192.168.1.5:42042", 500)).toBe(false);

    const throwProbe = obsidianProbe(async () => {
      throw new Error("no network");
    });
    expect(await throwProbe("http://192.168.1.5:42042", 500)).toBe(false);
  });

  it("times out a host that never answers", async () => {
    const hangProbe = obsidianProbe(
      () => new Promise(() => undefined) as never
    );
    expect(await hangProbe("http://10.0.0.9:42042", 20)).toBe(false);
  });
});