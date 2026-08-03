import { VaultAdapter } from "./vault";

export interface SnapshotInfo {
  relative_path: string;
  timestamp: number;
  size: number;
}

/** Maximum snapshots kept per file. */
export const MAX_PER_FILE = 32;

function versionsRoot(): string {
  return ".obsync/versions";
}

function snapshotDir(rel: string): string {
  return `${versionsRoot()}/${rel}`;
}

function nowMillis(): number {
  return Date.now();
}

/**
 * Snapshot filenames are `{stamp}` or `{stamp}-{n}` for same-millisecond
 * collisions. Lexicographic order of names equals chronological order because
 * `stamp` is a zero-padded epoch-millis string. This mirrors the Rust original,
 * which sorts PathBuf names and prunes from the front.
 */
function stampOf(name: string): number {
  return parseInt(name.split("-")[0] ?? "", 10);
}

async function siblingSnapshots(vault: VaultAdapter, rel: string): Promise<string[]> {
  const dir = snapshotDir(rel);
  const all = await vault.listFiles();
  const prefix = `${dir}/`;
  return all
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length))
    .filter((name) => !Number.isNaN(stampOf(name)))
    .sort();
}

/**
 * Port of core/src/filesystem/versioning.rs::snapshot_before_overwrite.
 * Copy `content` into the versions store under a fresh stamp, then prune to the
 * newest MAX_PER_FILE snapshots. Callers pass the bytes they are about to write
 * so the pre-overwrite content is preserved.
 */
export async function snapshotContent(
  vault: VaultAdapter,
  rel: string,
  content: Uint8Array,
  _size: number
): Promise<string> {
  const dir = snapshotDir(rel);
  const stamp = nowMillis();
  let name = `${stamp}`;
  let candidate = `${dir}/${name}`;
  let i = 1;
  while (await vault.exists(candidate)) {
    name = `${stamp}-${i}`;
    candidate = `${dir}/${name}`;
    i++;
  }
  await vault.write(candidate, content);

  const names = await siblingSnapshots(vault, rel);
  while (names.length > MAX_PER_FILE) {
    const oldest = names.shift();
    if (oldest) await vault.remove(`${dir}/${oldest}`);
  }
  return candidate;
}

/** List snapshots for one file, newest first. Mirrors list_snapshots. */
export async function listSnapshots(
  vault: VaultAdapter,
  rel: string
): Promise<SnapshotInfo[]> {
  const names = await siblingSnapshots(vault, rel);
  const out: SnapshotInfo[] = [];
  for (const name of names) {
    const s = await vault.stat(`${snapshotDir(rel)}/${name}`);
    out.push({ relative_path: rel, timestamp: stampOf(name), size: s?.size ?? 0 });
  }
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out;
}

/** List every snapshot across the vault, newest first. Mirrors list_all_snapshots. */
export async function listAllSnapshots(vault: VaultAdapter): Promise<SnapshotInfo[]> {
  const root = `${versionsRoot()}/`;
  const all = await vault.listFiles();
  const out: SnapshotInfo[] = [];
  for (const p of all.filter((x) => x.startsWith(root))) {
    const rel = p.slice(0, root.length - 1);
    const name = p.split("/").pop() ?? "";
    const stamp = stampOf(name);
    if (Number.isNaN(stamp)) continue;
    const s = await vault.stat(p);
    out.push({ relative_path: rel, timestamp: stamp, size: s?.size ?? 0 });
  }
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out;
}

/**
 * Port of restore_snapshot. Overwrites `rel` with the snapshot whose stamp
 * equals `timestamp` (choosing the newest when the stamp was suffixed).
 * Preserves the current content as a snapshot first.
 */
export async function restoreSnapshot(
  vault: VaultAdapter,
  rel: string,
  timestamp: number
): Promise<void> {
  const dir = snapshotDir(rel);
  const names = await siblingSnapshots(vault, rel);
  const matches = names.filter((n) => stampOf(n) === timestamp);
  if (matches.length === 0) {
    throw new Error(`snapshot ${timestamp} not found for ${rel}`);
  }
  const src = `${dir}/${matches[matches.length - 1]}`;
  const bytes = await vault.readBinary(src);
  if (await vault.exists(rel)) {
    const current = await vault.readBinary(rel);
    await snapshotContent(vault, rel, current, current.length);
  }
  await vault.write(rel, bytes);
}