<div align="center">

# Obsync

**Free, local-first P2P sync for your Obsidian vault. No cloud. No account. No subscription.**

Sync your Obsidian vault between your laptop and your phone over your own
network — direct and private. Your notes never touch a third-party server.

![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)
![Version: 1.0.4](https://img.shields.io/badge/version-1.0.4-blue)
![Status: alpha](https://img.shields.io/badge/status-alpha-orange)

</div>

---

## Why Obsync?

Obsidian Sync costs **$4/month** and sends your vault through Obsidian's cloud.
Obsync is an alternative that keeps your notes on your devices:

- **No cloud, no accounts** — devices talk directly over your LAN.
- **Direct P2P transport** — a dedicated sync protocol on your own network.
- **Pairing by fingerprint** — approve each device once; no passwords to share.
- **Conflict detection** — files edited on both sides are flagged, never
  silently clobbered.
- **Local-first** — your vault stays an ordinary folder on disk. No lock-in;
  leave anytime.
- **Works on desktop and mobile** — the same plugin runs on both, so a laptop
  pairs with a phone over a shared hotspot.
- **Near-instant** — vault changes propagate within a few hundred milliseconds
  (the mobile polls every 250 ms; both sides sync ~150 ms after an edit).

## Requirements

- **Obsidian desktop** (Windows, macOS, or Linux) on the device that runs the
  server.
- **Obsidian mobile** on the device that syncs as the client.
- Both devices on the **same network** (Wi-Fi or phone hotspot), and the
  client must be able to reach the server's IP on port `42042`.
- **Enable the plugin on both devices.** Server and client roles are a setting,
  not a separate app.

## Install

1. In Obsidian, open **Settings → Community plugins**, disable *Restricted
   mode*, and browse the catalog for **P2P Vault Sync** (this plugin).
2. Install and enable it on **both** devices.
3. Open **Settings → Obsync** — the laptop starts the server, the phone gets
   the server URL.

### First-time walkthrough

1. On the laptop: **Settings → Obsync → Start server**. The server listens on
   port `42042` and shows its IP + fingerprint.
2. On the phone: **Settings → Obsync**, set the server URL to the laptop's IP
   (e.g. `http://10.174.223.140:42042`), then **Sync now**.
3. The phone appears under **Awaiting approval** on the laptop — click
   **Approve**.
4. Tap **Sync now** again on the phone. Done — from here on it syncs
   automatically.

> The URL is normalized for you: `10.174.223.140:42042` works, no `http://`
> needed. See [`src/core/transport.ts`](src/core/transport.ts) (`normalizeServerUrl`).

## How it works

One device (usually your laptop) runs the **server**; the other device
(usually your phone) runs the **client**. The laptop is **authoritative for
deletions** — the phone is **additive-only**, so a partially synced phone can
never delete files on the server.

### Architecture

```text
Laptop (authoritative)                  Phone (additive client)
┌──────────────────────────────────┐    ┌───────────────────────────────┐
│ Obsidian app                     │    │ Obsidian app                  │
│  └─ Obsync plugin                │    │  └─ Obsync plugin             │
│      ├─ RPC server  :42042       │    │      └─ HTTP client           │
│      └─ Sync engine              │    │      └─ Sync engine           │
│          └─ .obsync/index.json   │    │          └─ .obsync/index.json│
│          └─ Vault folder         │    │          └─ Vault folder      │
└──────────────────────────────────┘    └───────────────────────────────┘
              │            ▲                    │            ▲
              └────────────┴────────────────────┴────────────┘
                           HTTP /rpc (requestUrl)
```

The laptop runs an RPC server on port `42042`; the phone (and the laptop's own
"Sync now") talk to it over plain HTTP `POST /rpc` — one protocol message per
request, the reply is the next message.

### Pairing a new device

```text
 Phone (client)                                Laptop (server)
      │ 1. pair_request (device_id, fingerprint, name)           │
      │─────────────────────────────────────────────────────────►│
      │ 2. pair_ack { approved: false }          device recorded │
      │◄─────────────────────────────────────────────────────────│  as pending
      │                                                          │
      │         3. Laptop user clicks "Approve"                  │
      │                device → .obsync/approved.json           │
      │                                                          │
      │ 4. pair_request (same device)                           │
      │─────────────────────────────────────────────────────────►│
      │ 5. pair_ack { approved: true }                          │
      │◄─────────────────────────────────────────────────────────│
      │ 6. hello (device_id)                                    │
      │─────────────────────────────────────────────────────────►│
      │ 7. hello_ack { approved: true }                         │
      │◄─────────────────────────────────────────────────────────│
      │ 8. full sync session follows                            │
```

### One sync session

```text
 Client (phone or laptop)                       Server (laptop)
      │ 1. hello                                              │
      │────────────────────────────────────────────────────────►│
      │                               2. refresh index (authoritative)
      │◄────────────────────────────────────────────────────────│ 3. hello_ack { approved }
      │ 4. manifest (client file states)                       │
      │────────────────────────────────────────────────────────►│
      │◄────────────────────────────────────────────────────────│ 5. manifest (server file states)
      │                   6. diff → pull / push / delete       │
      │ 7. file_request (path, offset)                         │
      │────────────────────────────────────────────────────────►│
      │◄────────────────────────────────────────────────────────│ 8. file_chunk (base64, is_last)
      │ 9. sync_operation (create / update / delete)           │
      │────────────────────────────────────────────────────────►│
      │◄────────────────────────────────────────────────────────│ 10. operation_ack
      │ 11. disconnect                                         │
```

Step 6 is where the client decides what to do with each file: pull files the
server has, push files only the client has, and apply tombstones. Every step
that touches a single file is isolated — a chronically-conflicting file cannot
stall the rest of the session.

### Conflict resolution

```text
   File differs on both sides
              │
              ▼
  Did either side change since the last agreed sync hash?
              │
      ┌───────┴────────┐
      ▼                ▼
    "No"             "Both changed"
      │                │
      ▼                ▼
  newer mtime wins    CONFLICT
  (no agreement,      → Settings → Obsync → Conflicts
   pre-v2 fallback)     Keep local / Keep remote / Keep both
```

> **Conflict model:** revisions are per-device counters and are *not* a reliable
> "both changed" signal — the real signal is the `synced_hash` column (the
> content hash the last sync agreed on). A conflict is flagged only when **both**
> sides changed since that agreement. See
> [`src/core/conflict.ts`](src/core/conflict.ts).

## Settings reference

Everything lives under **Settings → Obsync**:

| Section | What it does |
|---|---|
| **Device identity** | Device name + fingerprint shown to the server during pairing |
| **Sync server** | Start/stop the RPC server on the authoritative device (port 42042) |
| **Sync server URL** | Server URL for the client (normalized), and the sync poll interval (default 250 ms, min 100 ms) |
| **Auto-sync** | Sync on vault changes and (on mobile) poll the server every interval |
| **Sync now** | Force a session on demand (also available via the ribbon icon and the command palette) |
| **Devices** | Approved devices, pending approval requests, revoke access |
| **Conflicts** | Files changed on both sides — resolve per file: keep local / keep remote / keep both |
| **Versions** | Snapshot history of every file; restore any past version |

## How sync is triggered

- **On edit** — vault `create`/`modify`/`delete` events trigger a debounced
  sync (~150 ms) on both platforms.
- **On poll** — the phone polls the server every **250 ms** (configurable, min
  100 ms) to pick up remote changes; HTTP is request/response, so there is no
  push channel.
- **On demand** — the ribbon icon / "Sync now" command always forces a session.

Both are gated by a `syncInProgress` guard so sessions never overlap. See
[`main.ts`](main.ts).

## Limitations

- **One server, one vault at a time** — the server device is authoritative; a
  second phone can pair, but there is no multi-master mode yet.
- **Same-network only** — no relay/TURN; both devices must reach each other
  directly.
- **No filesystem watcher** — Obsidian's edit events trigger sync, and the
  server re-scans the vault at the start of every session, so files edited
  directly on disk (outside Obsidian) are picked up on the next sync. The
  client's disk may be an incomplete replica, so it only ever adds, never
  tombstones.
- **Alpha** — works end-to-end; expect rough edges. The sync engine is covered
  by 96 tests, including cross-language conformance tests against the Rust
  core.

## Development

```bash
npm install
npm run build      # tsc typecheck + esbuild bundle → main.js
npm test           # vitest (96 tests: engine, sync, store, scanner, crypto, pairing…)
```

The engine is a TypeScript port of the Rust sync engine in
[chintu79/obsync](https://github.com/chintu79/obsync), with cross-language
conformance tests keeping the two implementations equivalent.

### Project layout

| Path | What it is |
|---|---|
| [`main.ts`](main.ts) | Plugin entry: server/client bootstrap, auto-sync, status bar |
| [`src/core/engine.ts`](src/core/engine.ts) | Port of the Rust sync engine (index, manifest, conflict planning) |
| [`src/core/session.ts`](src/core/session.ts) | The sync session protocol (hello/manifest/pull/push) |
| [`src/core/pairing.ts`](src/core/pairing.ts) | Device approval + pending-request tracking |
| [`src/core/transport.ts`](src/core/transport.ts) | HTTP framing + server + URL normalization |
| [`src/core/store.ts`](src/core/store.ts) | JSON state store (`.obsync/index.json`) |
| [`src/core/conflict.ts`](src/core/conflict.ts) | Divergence detection (the `synced_hash` rule) |
| [`src/ui/settings-tab.ts`](src/ui/settings-tab.ts) | Settings UI: server, URL, auto-sync, devices, conflicts, versions |
| [`docs/device-test.md`](docs/device-test.md) | End-to-end checklist for testing on real hardware |

### Release

Releases are cut by maintainers. Tag a version with the **exact
`manifest.json` version, no `v` prefix**:

```bash
git tag 1.0.4
git push origin 1.0.4
```

The [release workflow](.github/workflows/release.yml) builds `main.js` and
attaches `main.js` + `manifest.json` + `styles.css` to a GitHub release.

## Contributing

We welcome contributions of all kinds — code, docs, bug reports, feature ideas.
See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## Related

- [Obsync core (Rust)](https://github.com/chintu79/obsync) — the sync engine,
  `httpd` dashboard, and Android app this plugin's engine is ported from.
- [Device test checklist](docs/device-test.md) — verify pairing, both-way sync,
  conflicts, and restart persistence on real hardware.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE](LICENSE))

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in Obsync shall be dual-licensed as above, without any additional
terms or conditions.

© 2026 Obsync contributors.