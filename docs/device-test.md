# Obsync plugin — device verification checklist

Live laptop ⇄ phone sync test over the phone's hotspot. Run this before
submitting to the community catalog.

## Prerequisites

- Laptop with the `obsync-plugin` repo checked out and Node available.
- Phone with Obsidian installed.
- Phone's hotspot enabled (the AGENTS.md environment uses the phone as the
  network bridge; laptop LAN IP `10.174.223.140`).

## 1. Build + install on the laptop

```bash
./install-to-vault.sh "$HOME/Desktop/MyObsidianVault"
```

Or build once and copy manually:

```bash
npm run build
# copy main.js, manifest.json, styles.css into <vault>/.obsidian/plugins/obsync/
```

Open the laptop vault in Obsidian, enable the plugin:
Settings → Community plugins → Obsync (toggle on).

## 2. Start the server

Settings → Obsync → **Start**. Expect the notice "Obsync server listening on
:42042". Note the fingerprint shown in the Device identity row.

> If 42042 is taken, the server picks another port — the port is in the
> notice. Adjust the phone's URL accordingly.

## 3. Install on the phone

- Copy `main.js`, `manifest.json`, `styles.css` into the phone vault's
  `.obsidian/plugins/obsync/` (via a file manager over USB or the hotspot
  shared folder), then restart Obsidian.
- Or, once the plugin is published to the community catalog, install from
  Settings → Community plugins directly.

## 4. Point the phone at the laptop

Phone Settings → Obsync → **Sync server URL**:
`http://<laptop-hotspot-ip>:42042` (e.g. `http://10.174.223.140:42042`).

## 5. Pair + approve

Phone: Settings → Obsync → **Sync now** → "device not approved" notice.

Laptop: the phone appears in Settings → Obsync → **Devices** with its
fingerprint. Verify the fingerprint matches the phone's, then **approve** (it
is auto-approved on the laptop side for a first sync — confirm in the Devices
list).

## 6. Sync checks

| # | Test | Expected |
| --- | --- | --- |
| 1 | Phone **Sync now** with no changes | "up to date", 0 pulled / 0 pushed |
| 2 | Create `phone.md` on the phone, sync | 1 pushed; file appears on laptop |
| 3 | Create `laptop.md` on the laptop, sync | 1 pulled; file appears on phone |
| 4 | Edit `laptop.md` on laptop, then sync on phone | 1 pulled, content updated on phone |
| 5 | Delete `laptop.md` on laptop, sync on phone | phone deletes it (server is authoritative) |
| 6 | Delete `phone.md` on phone, sync on laptop | phone keeps a copy? no — phone tombstones only push; verify laptop keeps the file (additive client cannot delete server files) |
| 7 | Edit the SAME note on both sides, then sync | a conflict copy `<name>.sync-conflict-<ts>.md` appears; original not clobbered |
| 8 | Server stop (toggle), phone sync | clean error notice, no crash |

## 7. Conflict resolution check

1. Create `conflict-test.md` identical on both sides, sync (in sync).
2. On the laptop, append "laptop edit".
3. On the phone, append "phone edit".
4. Sync on the phone → conflict detected.
5. Laptop Settings → Obsync → Conflicts → keep local / remote / both, verify
   the file and any conflict copy.

## 8. Restart persistence

Restart both Obsidian apps. Identity persists (same fingerprint). Approved
device persists (`.obsync/approved.json`). No re-pairing needed.

## Done

If all checks pass, the plugin is ready to submit at
https://community.obsidian.md/plugins (New plugin → `chintu79/obsync-plugin`).
