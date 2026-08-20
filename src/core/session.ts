import { resolveDivergence, SideOutcome } from "./conflict";
import { contentHash } from "./hash";
import { FileState } from "./state";
import { HttpTransport } from "./transport";
import {
  FileChunkPayload,
  FileRequestPayload,
  HelloAckPayload,
  HelloPayload,
  OperationAckPayload,
  ProtocolMessage,
  SyncOperationPayload,
  newMessage,
} from "./protocol";
import { SyncEngine, SyncReport } from "./engine";
import { VaultAdapter } from "./vault";
import { manifestToWire, manifestFromWire } from "./protocol";

const CHUNK_SIZE = 65536;

/**
 * Port of core/src/sync/peer.rs::run_client_session, with the socket peer
 * replaced by an HTTP transport. The message ordering (hello handshake,
 * manifest exchange, pull, push, deletes, disconnect) is identical; only the
 * framing differs.
 */
export async function runClientSession(
  engine: SyncEngine,
  transport: HttpTransport,
  hello?: Partial<HelloPayload>
): Promise<SyncReport> {
  // 1. Hello handshake: server confirms this device is approved.
  const helloMsg = newMessage("hello", 0, {
    protocol_version: 1,
    device_id: engine.deviceIdValue(),
    device_name: "Obsync",
    public_key_fingerprint: "",
    ...(hello ?? {}),
  });
  const helloReply = await transport.exchange(helloMsg);
  if (helloReply.message_type !== "hello_ack") {
    throw new Error("expected HelloAck from server");
  }
  const ack = helloReply.payload as HelloAckPayload;
  if (!ack.approved) {
    throw new Error(`device not approved by server`);
  }

  // 2. Exchange manifests
  const local = await engine.buildManifest();
  const localReply = await transport.exchange(
    newMessage("manifest", 1, manifestToWire(local))
  );
  if (localReply.message_type !== "manifest") {
    throw new Error("expected Manifest from server");
  }
  const remote = manifestFromWire(localReply.payload as import("./protocol").WireManifest);

  const localMap = new Map(local.files.map((f) => [f.relative_path, f]));
  const remoteMap = new Map(remote.files.map((f) => [f.relative_path, f]));
  const remoteTombstones = new Set(remote.tombstones.map((t) => t.relative_path));
  const localTombstones = new Map(local.tombstones.map((t) => [t.relative_path, t]));

  const report: SyncReport = { pulled_files: 0, pushed_files: 0, deleted_files: 0, conflicts: 0 };
  let requestId = 1;

  // 3. Pull: files on server that we don't have (or differ, server newer).
  // Each file is isolated so a single failure (e.g. a chronically-conflicting
  // path that exhausts conflict-copy names) cannot abort the session and
  // starve every other file — a new note must still reach the device even if
  // one .obsidian settings file keeps failing.
  for (const [path, rf] of remoteMap) {
    try {
      const lf = localMap.get(path);
      if (!lf) {
        const lt = localTombstones.get(path);
        if (lt) {
          // We deleted this locally at some point. Our deletion only beats a
          // remote file that still matches the version we last agreed on
          // (agreed_hash). If the remote changed the file after we last saw it
          // — even a single millisecond after our tombstone, which wall-clock
          // comparisons can't tell apart — the edit wins: pull it back, which
          // also retires our stale tombstone so step 6 never re-deletes it.
          // Pre-upgrade tombstones (no agreed_hash) fall back to a strict
          // deleted_at > modified_at comparison.
          const stillAgreed =
            lt.agreed_hash !== null &&
            lt.agreed_hash !== undefined &&
            bytesEq(lt.agreed_hash, rf.content_hash);
          if (stillAgreed) continue;
          if (!lt.agreed_hash && lt.deleted_at > rf.modified_at) continue;
          localTombstones.delete(path);
        }
        await pullFile(engine, transport, path, rf, () => requestId++);
        report.pulled_files += 1;
      } else if (!bytesEq(lf.content_hash, rf.content_hash)) {
        const outcome = resolveDivergence(lf, rf);
        if (outcome === SideOutcome.Conflict) {
          const copy = await engine.planConflictCopy(path, rf.content_hash, true);
          if (copy) {
            const size = await pullFileTo(engine, transport, path, rf, copy, () => requestId++);
            await engine.recordRemoteFile(copy, rf.content_hash, size, rf.modified_at);
          }
          report.conflicts += 1;
        } else if (outcome === SideOutcome.LocalWins) {
          await pushFile(engine, transport, path, lf, () => requestId++);
          report.pushed_files += 1;
        } else {
          await pullFile(engine, transport, path, rf, () => requestId++);
          report.pulled_files += 1;
        }
      }
    } catch (e) {
      console.warn(`obsync: skipping pull of ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 4. Push: files only on local
  for (const [path, lf] of localMap) {
    if (!remoteMap.has(path) && !remoteTombstones.has(path)) {
      try {
        await pushFile(engine, transport, path, lf, () => requestId++);
        report.pushed_files += 1;
      } catch (e) {
        console.warn(`obsync: skipping push of ${path}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // 5. Deletes: remote tombstones → delete locally
  for (const path of remoteTombstones) {
    if (localMap.has(path)) {
      try {
        await engine.applyOperation({ op: "delete", path });
        report.deleted_files += 1;
      } catch (e) {
        console.warn(`obsync: skipping delete of ${path}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // 6. Push local tombstones → tell server to delete
  for (const path of localTombstones.keys()) {
    if (remoteMap.has(path)) {
      try {
        const payload: SyncOperationPayload = {
          operation_type: 2,
          relative_path: path,
          size: 0,
          modified_at: 0,
        };
        await transport.exchange(newMessage("sync_operation", requestId++, payload));
      } catch (e) {
        console.warn(`obsync: skipping tombstone for ${path}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // 7. Done
  await transport.exchange(newMessage("disconnect", requestId++, {}));
  return report;
}

/**
 * Server-side session state. The HTTP transport is request/response, so a
 * multi-message file transfer (SyncOperation create/update → FileChunk*) needs
 * per-session context between requests. The Rust TCP server keeps this in the
 * socket's read loop; here it lives in a session registry keyed by
 * `request_id` of the originating SyncOperation.
 */
interface PendingWrite {
  dest: string;
  originalDest: string;
  expected: Uint8Array | null;
  modified_at: number;
  chunks: Uint8Array[];
}

export class SyncServer {
  private pending = new Map<number, PendingWrite>();

  constructor(
    private engine: SyncEngine,
    private vault: VaultAdapter
  ) {}

  async handle(msg: ProtocolMessage): Promise<ProtocolMessage> {
    switch (msg.message_type) {
      case "hello": {
        // No pairing gate here — PairingServer wraps this to gate approvals.
        // Server is authoritative: refresh the index so files edited directly
        // on disk reach the client this session (matches the Rust engine).
        await this.engine.refreshIndex(true);
        return newMessage("hello_ack", msg.request_id, {
          approved: true,
          server_device_id: this.engine.deviceIdValue(),
          server_device_name: "Obsync Desktop",
          server_public_key: "",
        });
      }

      case "manifest": {
        const local = await this.engine.buildManifest();
        return newMessage("manifest", msg.request_id, manifestToWire(local));
      }

      case "file_request": {
        const req = msg.payload as FileRequestPayload;
        // A file can disappear between the manifest exchange and the chunk
        // request (e.g. the authoritative server just tombstoned it, or a
        // background watcher moved it). Reply with an ack error instead of
        // letting the read throw an opaque HTTP 500; the client skips the file.
        try {
          return newMessage("file_chunk", msg.request_id, await this.chunkAt(req));
        } catch (e) {
          return ack(
            false,
            `cannot read ${req.relative_path}: ${e instanceof Error ? e.message : e}`
          );
        }
      }

      case "sync_operation": {
        const op = msg.payload as SyncOperationPayload;
        return this.handleOperation(msg.request_id, op);
      }

      case "file_chunk": {
        return this.handleChunk(msg);
      }

      case "disconnect": {
        this.pending.delete(msg.request_id);
        return ack(true);
      }

      case "ping": {
        // Liveness probe used by zero-config server discovery. Stateless —
        // any reachable Obsync server answers ok, which is what distinguishes
        // it from a random device that happens to have the port open.
        return ack(true);
      }

      default:
        return ack(false, `unexpected message type ${msg.message_type}`);
    }
  }

  private async chunkAt(req: FileRequestPayload): Promise<FileChunkPayload> {
    const data = await this.vault.readBinary(req.relative_path);
    const offset = req.offset;
    const end = Math.min(offset + CHUNK_SIZE, data.length);
    return {
      relative_path: req.relative_path,
      offset,
      data_b64: bytesToBase64(data.slice(offset, end)),
      is_last: end === data.length,
    };
  }

  private async handleOperation(
    sessionId: number,
    op: SyncOperationPayload
  ): Promise<ProtocolMessage> {
    const path = op.relative_path;
    if (op.operation_type === 2) {
      await this.engine.applyOperation({ op: "delete", path });
      return ack(true);
    }
    if (op.operation_type !== 0 && op.operation_type !== 1) {
      return ack(false, `unknown operation type ${op.operation_type}`);
    }

    // create/update: plan the destination, then wait for the file_chunk
    // exchanges carrying content.
    const expected = op.content_hash ? hexToBytes(op.content_hash) : null;
    const copy = expected
      ? await this.engine.planConflictCopy(path, expected, false)
      : null;
    const dest = copy ?? path;
    this.pending.set(sessionId, {
      dest,
      originalDest: path,
      expected,
      modified_at: op.modified_at,
      chunks: [],
    });
    return ack(true, undefined, dest !== path ? dest : undefined);
  }

  private async handleChunk(msg: ProtocolMessage): Promise<ProtocolMessage> {
    const chunk = msg.payload as FileChunkPayload;
    const pend = this.pending.get(msg.request_id);
    if (!pend) {
      return ack(false, "no pending operation for this request_id");
    }
    pend.chunks.push(base64ToBytes(chunk.data_b64));
    if (!chunk.is_last) {
      return ack(true); // more chunks coming
    }

    const data = concatBytes(pend.chunks);
    this.pending.delete(msg.request_id);
    const hash = pend.expected ?? contentHash(data);
    await this.vault.write(pend.dest, data);
    if (pend.dest !== pend.originalDest) {
      await this.engine.recordRemoteFile(pend.dest, hash, data.length, pend.modified_at);
    } else {
      await this.engine.recordRemoteFile(pend.originalDest, hash, data.length, pend.modified_at);
    }
    return ack(true, undefined, pend.dest !== pend.originalDest ? pend.dest : undefined);
  }
}

async function pullFile(
  engine: SyncEngine,
  transport: HttpTransport,
  path: string,
  remote: FileState,
  nextId: () => number
): Promise<void> {
  const size = await pullFileTo(engine, transport, path, remote, path, nextId);
  await engine.recordRemoteFile(path, remote.content_hash, size, remote.modified_at);
}

async function pullFileTo(
  engine: SyncEngine,
  transport: HttpTransport,
  path: string,
  remote: FileState,
  dest: string,
  nextId: () => number
): Promise<number> {
  const req: FileRequestPayload = {
    relative_path: path,
    content_hash: hexOfBytes(remote.content_hash),
    offset: 0,
  };
  let total = 0;
  let isLast = false;
  let offset = 0;
  const buf: Uint8Array[] = [];
  do {
    req.offset = offset;
    const reply = await transport.exchange(newMessage("file_request", nextId(), req));
    if (reply.message_type !== "file_chunk") {
      const err = (reply.payload as OperationAckPayload | undefined)?.error;
      throw new Error(
        `server could not send ${path}${err ? `: ${err}` : ""}`
      );
    }
    const chunk = reply.payload as FileChunkPayload;
    const bytes = base64ToBytes(chunk.data_b64);
    buf.push(bytes);
    total += bytes.length;
    offset += bytes.length;
    isLast = chunk.is_last;
  } while (!isLast);

  const data = concatBytes(buf);
  const actual = contentHash(data);
  if (!bytesEq(actual, remote.content_hash)) {
    // hash mismatch after pull — matches Rust's warn-only behavior
  }
  await engine.vaultAdapter().write(dest, data);
  return total;
}

async function pushFile(
  engine: SyncEngine,
  transport: HttpTransport,
  path: string,
  local: FileState,
  nextId: () => number
): Promise<void> {
  const sessionId = nextId();
  const payload: SyncOperationPayload = {
    operation_type: 0,
    relative_path: path,
    content_hash: hexOfBytes(local.content_hash),
    size: local.size,
    modified_at: local.modified_at,
  };
  await transport.exchange(newMessage("sync_operation", sessionId, payload));
  await sendFileData(engine, transport, path, sessionId);
  await engine.markSynced(path);
}

async function sendFileData(
  engine: SyncEngine,
  transport: HttpTransport,
  path: string,
  sessionId: number
): Promise<void> {
  const data = await engine.vaultAdapter().readBinary(path);
  const total = data.length;
  let offset = 0;
  do {
    const end = Math.min(offset + CHUNK_SIZE, total);
    const isLast = end === total;
    const chunk: FileChunkPayload = {
      relative_path: path,
      offset,
      data_b64: bytesToBase64(data.slice(offset, end)),
      is_last: isLast,
    };
    await transport.exchange(newMessage("file_chunk", sessionId, chunk));
    offset = end;
    if (isLast) break;
  } while (offset < total);
}

function ack(ok: boolean, error?: string, landedPath?: string): ProtocolMessage {
  const payload: OperationAckPayload = { ok, error, landed_path: landedPath };
  return newMessage("operation_ack", 0, payload);
}

// ---- byte helpers ----

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hexOfBytes(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
