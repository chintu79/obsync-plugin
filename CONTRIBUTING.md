# Contributing to Obsync (Obsidian plugin)

Thanks for your interest! Obsync is a local-first, peer-to-peer sync plugin for
Obsidian. All sync happens directly between your devices over your own network
— no cloud, no accounts.

## Code of Conduct

This project is governed by the [Contributor Covenant](CODE_OF_CONDUCT.md).
By participating you agree to abide by its terms.

## Development Setup

### Prerequisites

| Tool    | Version        | Notes                                |
| ------- | -------------- | ------------------------------------ |
| Node.js | 20+            | [nodejs.org](https://nodejs.org)      |
| npm     | 10+            | ships with Node.js                    |
| Rust    | stable (1.97+) | only needed for cross-checking against the Rust core |

The plugin is pure TypeScript — no native build step, no Obsidian SDK install.
`npm install` is all you need.

```bash
npm install
npm run build      # tsc typecheck + esbuild bundle → main.js
npm test           # vitest (96 tests)
```

## Architecture in one paragraph

The laptop runs the plugin as an **RPC server** on port 42042; the phone (and
the laptop's own "Sync now") talks to it over plain HTTP `POST /rpc` — one
protocol message per request. Each sync session starts with `hello`, then both
sides exchange manifests and the client diffs them into pull/push/delete
operations. The laptop is **authoritative for deletions**; the phone is
**additive-only**. See the "How it works" section of [README.md](README.md) for
the message-level sequence diagrams, and `src/core/*` for the implementation.

## Design Principles

- **Correctness over speed.** Data safety is the top priority. This plugin
  moves people's notes — never risk their data for a faster path.
- **Parity with the Rust core.** The engine is a TypeScript port of
  [chintu79/obsync](https://github.com/chintu79/obsync). Behavioral changes
  should be mirrored there (or justified in the PR), and cross-language
  conformance tests keep the two implementations equivalent.
- **YAGNI.** Do not add features "just in case."
- **Small dependencies.** Every dependency must justify its cost. The plugin
  bundles with esbuild; prefer std when it will do.
- **Test all the things.** Especially sync convergence.

## Code Style

- TypeScript: match the existing style; the build runs `tsc --noEmit`, so the
  typecheck must stay clean.
- Follow the Obsidian marketplace lint rules (eslint-plugin-obsidianmd):
  no static `document`/`window` access at module scope (tests run under
  vitest, which has no `window`), no `node:*` imports outside test-only
  files, no inline styles (use `styles.css` classes instead).
- No unnecessary comments. Code should be self-documenting where possible.
- Use meaningful names. Avoid abbreviations.

## Testing

```bash
npm test                 # all tests
npx vitest run src/core  # engine / sync / store / scanner / crypto tests only
```

### What to test

All new code should include tests for:

- Normal operation paths
- Error conditions
- Edge cases (empty files, very large files, Unicode paths, missing state files)
- Sync convergence (two peers must always end up identical)
- State persistence (restart must not lose approvals or sync state)

### Testing on real devices

The [docs/device-test.md](docs/device-test.md) checklist covers end-to-end
verification: pairing, both-way sync, conflicts, and restart persistence on
real hardware. Run it before opening a PR that touches the sync path.

## Pull Request Process

1. Open an issue describing the change before working on it (unless trivial).
2. Implement the change with tests.
3. Ensure `npm run build` and `npm test` pass.
4. Submit a PR with a clear description of what and why.

## Commit Messages

Follow conventional commits:

```
feat: add selective sync scope to the engine
fix: handle edge case when temp file already exists
docs: update pairing protocol documentation
perf: reduce allocations in manifest comparison
test: add conformance test for rename conflict
```

## Release Process

Releases are cut by maintainers; a PR that bumps `manifest.json` version needs
a matching entry in `versions.json`:

1. Bump `manifest.json` `version` and `versions.json`.
2. Tag a release with the **exact version string, no `v` prefix**
   (Obsidian requires the tag to match `manifest.json` exactly):
   ```bash
   git tag 1.0.4
   git push origin 1.0.4
   ```
3. CI attaches `main.js` + `manifest.json` + `styles.css` to the GitHub
   release (see `.github/workflows/release.yml`).