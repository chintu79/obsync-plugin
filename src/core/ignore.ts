const IGNORED_PREFIXES = [".~", "~$", "."];

const IGNORED_SUFFIXES = [".swp", ".swx", ".tmp", ".temp", ".bak", ".sync-temp", "~"];

const IGNORED_NAMES = [".DS_Store", "Thumbs.db", "thumbs.db", ".directory"];

/**
 * Port of core/src/filesystem/ignore.rs::should_ignore.
 * `path` is a "/"-separated relative path (Obsidian style).
 *
 * The Rust scanner walks directories and skips a hidden directory such as
 * `.obsync/` before descending. Over a flat file list we reproduce that by
 * checking every component: if any component is a hidden dot-name other than
 * `.obsidian`, the path is ignored. This keeps `.obsidian/config.json`
 * indexed while excluding `.obsync/` internals (the index file, snapshots).
 */
export function shouldIgnore(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1] ?? "";

  if (name === "") return true;
  if (IGNORED_NAMES.includes(name)) return true;
  if (IGNORED_SUFFIXES.some((s) => name.endsWith(s))) return true;
  if (IGNORED_PREFIXES.some((p) => name.startsWith(p))) return true;

  // The plugin's own install folder must never sync: it holds the device
  // identity (private key), and both devices rewrite their own copy, so it
  // conflicts forever and can exhaust conflict-copy names.
  if (
    path === ".obsidian/plugins/obsync-p2p" ||
    path.startsWith(".obsidian/plugins/obsync-p2p/")
  ) {
    return true;
  }

  for (const part of parts) {
    if (part.startsWith(".") && part.length > 1 && part !== ".obsidian") {
      return true;
    }
  }

  return false;
}
