<div align="center">

# Obsync

**Free, local-first P2P sync for your Obsidian vault. No cloud. No account. No subscription.**

Sync your Obsidian vault between your laptop and your phone over your own
network — encrypted, direct, and private. Your notes never touch a third-party
server.

![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)

</div>

---

## Why Obsync?

Obsidian Sync costs **$4/month** and sends your vault through Obsidian's cloud.
Obsync is an alternative that keeps your notes on your devices:

- **No cloud, no accounts** — devices talk directly over your LAN.
- **Encrypted P2P transport** — a dedicated sync protocol on your own network.
- **Pairing by fingerprint** — approve each device once; no passwords to share.
- **Conflict detection** — files edited on both sides are flagged, never silently clobbered.
- **Local-first** — your vault stays an ordinary folder on disk. No lock-in; leave anytime.
- **Works on desktop and mobile** — the same plugin runs on both, so a laptop
  pairs with a phone over the hotspot.

## How it works

One device (usually your laptop) runs the **server**: Obsidian → Settings →
Obsync → **Start**. The other device (usually your phone) runs the **client**:
set the server URL (e.g. `http://192.168.1.5:42042`) and press **Sync now**.

The laptop is authoritative for deletions; the phone is additive-only, so a
partially synced phone can never delete files on the server. Every edit made on
either side is detected by re-scanning the vault, and diverged files are
surfaced as conflicts you resolve in the settings tab.

## Install

1. In Obsidian, open **Settings → Community plugins** and install **Obsync** from the catalog.
2. Enable it.
3. Open **Settings → Obsync** to start the server, pair a device, or configure the server URL.

## Development

```bash
npm install
npm run build      # tsc typecheck + esbuild bundle → main.js
npm test           # vitest (81 tests: engine, sync, store, scanner, crypto, pairing…)
```

The engine is a TypeScript port of the Rust sync engine in
[chintu79/obsync](https://github.com/chintu79/obsync), with cross-language
conformance tests keeping the two implementations equivalent.

### Release

Tag a version (no `v` prefix — Obsidian requires the tag to match
`manifest.json` exactly):

```bash
git tag 1.0.0
git push origin 1.0.0
```

The [release workflow](.github/workflows/release.yml) builds `main.js` and
attaches `main.js` + `manifest.json` + `styles.css` to a GitHub release.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE](LICENSE))

at your option.

© 2026 Obsync contributors.
