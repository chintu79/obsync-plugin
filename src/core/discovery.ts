import { decodeMessage, encodeMessage, pingMessage, DEFAULT_PORT } from "./transport";

/**
 * Zero-config server discovery for the mobile client.
 *
 * Strategy (in order, first hit wins):
 *   1. localhost/127.0.0.1 on the default port — the server runs on the same
 *      device (e.g. Obsidian desktop hosting the server next to an emulator,
 *      or a future same-device server).
 *   2. A bounded LAN scan of the common home subnets, probing the Obsync RPC
 *      endpoint on the default port. A successful probe must answer a ping
 *      with a valid protocol message, so an unrelated service on that port is
 *      not mistaken for a server.
 *
 * mDNS/Bonjour would be the textbook answer for step 2, but Obsidian plugins
 * only get HTTP (`requestUrl`) — no UDP sockets — so the plugin cannot
 * multicast or listen for mDNS advertisements. The bounded HTTP probe is the
 * lightweight equivalent that works on Windows, macOS, and Linux.
 */

/** Common consumer-router subnets (probed last-to-first octet is host). */
export const LAN_SUBNETS = ["192.168.0", "192.168.1", "10.0.0"] as const;

/** The URL to probe for a local server. */
export function localCandidates(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

/** Host octets for one subnet, skipping network (x.0) and broadcast (x.255). */
function hostsInSubnet(subnet: string): string[] {
  const hosts: string[] = [];
  for (let i = 1; i <= 254; i++) hosts.push(`${subnet}.${i}`);
  return hosts;
}

/** All LAN hosts the scan will probe (host octets only, no URL). */
export function lanHosts(): string[] {
  return LAN_SUBNETS.flatMap((subnet) => hostsInSubnet(subnet));
}

/** Full base URLs for the LAN scan. */
export function lanCandidates(port: number): string[] {
  return lanHosts().map((host) => `http://${host}:${port}`);
}

/**
 * Ask one base URL whether an Obsync server answers. Returns false on any
 * network failure, non-2xx response, or protocol mismatch — never throws.
 */
export type ServerProbe = (baseUrl: string, timeoutMs: number) => Promise<boolean>;

function resolveAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => globalThis.setTimeout(() => resolve(value), ms));
}

/**
 * Probe an Obsync server via Obsidian's `requestUrl` (the only HTTP client on
 * mobile). The ping must round-trip as a valid protocol message with ok:true;
 * anything else means "not our server".
 */
export function obsidianProbe(
  requestUrlFn: (param: {
    url: string;
    method: string;
    contentType?: string;
    body?: string | ArrayBuffer;
    headers?: Record<string, string>;
    throw: boolean;
  }) => Promise<{ status: number; text: string; arrayBuffer: ArrayBuffer }>
): ServerProbe {
  return async (baseUrl, timeoutMs) => {
    try {
      const resp = await Promise.race([
        requestUrlFn({
          url: `${baseUrl}/rpc`,
          method: "POST",
          contentType: "application/json",
          body: encodeMessage(pingMessage()),
          throw: false,
        }),
        resolveAfter(timeoutMs, { status: 0, text: "", arrayBuffer: new ArrayBuffer(0) }),
      ]);
      if (!resp || resp.status < 200 || resp.status >= 400) return false;
      const msg = decodeMessage(resp.text);
      return (
        msg.message_type === "operation_ack" &&
        (msg.payload as { ok?: boolean } | null)?.ok === true
      );
    } catch {
      return false;
    }
  };
}

export interface DiscoveryOptions {
  /** Port to probe (defaults to the Obsync RPC port). */
  port?: number;
  /** The probe to use (injectable for tests). */
  probe: ServerProbe;
  /** Per-host timeout; the LAN scan shrinks it to fit the remaining budget. */
  probeTimeoutMs?: number;
  /** Hard stop for the whole discovery attempt (localhost probes excluded). */
  budgetMs?: number;
  /** LAN scan on/off (off for a same-device-only deployment). */
  includeLan?: boolean;
  /** How many LAN hosts are probed concurrently. */
  concurrency?: number;
  /** Fired after each LAN batch with (tried, total). */
  onProgress?: (tried: number, total: number) => void;
}

export interface DiscoveryOutcome {
  found: boolean;
  /** Base URL (http://host:port) when found. */
  url?: string;
  /** Where the server was found. */
  phase: "localhost" | "lan";
}

export async function discoverServer(
  opts: DiscoveryOptions
): Promise<DiscoveryOutcome> {
  const port = opts.port ?? DEFAULT_PORT;
  const timeoutMs = opts.probeTimeoutMs ?? 600;
  const deadline = Date.now() + (opts.budgetMs ?? 9000);
  const concurrency = opts.concurrency ?? 32;

  // 1. Same device first.
  for (const base of localCandidates(port)) {
    if (await opts.probe(base, timeoutMs)) {
      return { found: true, url: base, phase: "localhost" };
    }
  }

  // 2. Bounded LAN scan of common subnets.
  if (opts.includeLan === false) return { found: false, phase: "lan" };
  const queue = lanCandidates(port);
  const total = queue.length;
  let tried = 0;
  while (queue.length > 0 && Date.now() < deadline) {
    const batch = queue.splice(0, concurrency);
    const remaining = deadline - Date.now();
    const batchTimeout = Math.max(200, Math.min(timeoutMs, remaining));
    const results = await Promise.all(batch.map((base) => opts.probe(base, batchTimeout)));
    tried += batch.length;
    opts.onProgress?.(tried, total);
    const hit = results.indexOf(true);
    if (hit !== -1) {
      return { found: true, url: batch[hit], phase: "lan" };
    }
  }
  return { found: false, phase: "lan" };
}
