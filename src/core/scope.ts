/**
 * Port of core/src/sync/scope.rs — per-file/folder sync selection.
 *
 * A scope is a pure filter over the authoritative index: it decides what a
 * peer sees and what this side pulls/pushes/deletes. It never touches stored
 * state, so excluding a file keeps it on disk and re-including it resumes
 * with the last agreement intact (no false conflicts).
 *
 * `entries` is the include list (empty = whole vault); `excludes` are
 * per-file overrides that win over any include. Persisted as JSON in plugin
 * data; `excludes` is optional in stored JSON so pre-exclusion data loads.
 */

export type ScopeKind = "file" | "folder";

export interface ScopeEntry {
  kind: ScopeKind;
  /** Vault-relative "/"-separated path. */
  path: string;
}

export interface Scope {
  entries: ScopeEntry[];
  excludes: string[];
}

/** The whole-vault scope (backward-compatible default). */
export function everythingScope(): Scope {
  return { entries: [], excludes: [] };
}

export function isEverything(scope: Scope): boolean {
  return scope.entries.length === 0 && scope.excludes.length === 0;
}

function normalize(rel: string): string {
  return rel.replace(/\\/g, "/");
}

/** True when `rel` may sync under this scope. Exclusions win. */
export function allows(scope: Scope, rel: string): boolean {
  const s = normalize(rel);
  if (scope.excludes.includes(s)) return false;
  if (scope.entries.length === 0) return true;
  return scope.entries.some((e) => {
    if (e.kind === "file") return e.path === s;
    return s === e.path || s.startsWith(e.path + "/");
  });
}

/** Combine two scopes: allowed if either allows it, excluded if either excludes it. */
export function mergeScopes(a: Scope, b: Scope): Scope {
  const seen = new Set<string>();
  const entries: ScopeEntry[] = [];
  for (const e of [...a.entries, ...b.entries]) {
    const key = `${e.kind}:${e.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(e);
  }
  entries.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const excludes = [...new Set([...a.excludes, ...b.excludes])].sort();
  return { entries, excludes };
}

/**
 * Parse a scope from untrusted saved data. Anything malformed degrades to
 * "whole vault" so a corrupt data.json can never silently hide files.
 */
export function parseScope(raw: unknown): Scope {
  if (!raw || typeof raw !== "object") return everythingScope();
  const obj = raw as { entries?: unknown; excludes?: unknown };
  const entries: ScopeEntry[] = Array.isArray(obj.entries)
    ? obj.entries
        .filter(
          (e): e is ScopeEntry =>
            !!e &&
            typeof e === "object" &&
            typeof (e as ScopeEntry).path === "string" &&
            ((e as ScopeEntry).kind === "file" || (e as ScopeEntry).kind === "folder")
        )
        .map((e) => ({ kind: e.kind, path: normalize(e.path) }))
    : [];
  const excludes: string[] = Array.isArray(obj.excludes)
    ? obj.excludes.filter((p): p is string => typeof p === "string").map(normalize)
    : [];
  return { entries, excludes };
}
