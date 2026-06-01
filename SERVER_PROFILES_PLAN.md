# Server Config Profiles

The server panel exposes exactly **two ways to interact with each game**:

1. **Profiles** — a named, structured *startup config* (what the server boots as):
   map/world + rotation, gameplay settings, access toggles. Save many, pick one,
   **Apply** to make it live. Durable, in SQLite.
2. **Live commands** — ephemeral RCON/console (the Runtime panel). Change the
   *running* server only; never written back to the startup config; gone on restart.

**Shipped for all four games** (GMOD, Factorio, Counter-Strike, Minecraft). Panel
infra detail lives in [`INFRA.md`](INFRA.md) + the CLAUDE.md gotchas; this file is
the profiles design + as-built record.

## Persistence model (the core rule)

A profile is the startup config the server boots as. Runtime/live amendments are
ephemeral and **never** flow back; the only path from runtime → startup is
explicitly editing + saving the profile. So `applyProfileSettings` (writes the
managed startup keys) and the live layer (touches running state) never overlap.
Snapshot-and-apply, **non-authoritative**: the box stays hand-editable;
`captureProfile` pulls the box's current state back into a profile.

## Architecture

```
servers.html → /api/servers → service → connector → ProxmoxClient → PVE API
                                            └→ serverStore (SQLite: server_profiles)
```

- **DB** (migration `003`): `server_profiles` (id, server_id, name, settings JSON)
  + `server_active_profile` (per-server pointer). Per-server scoped — no cross-game
  config objects.
- **Generic lifecycle on `BaseConnector`**: list/get/create/update/delete/apply/
  capture + an auto-seeded "Default". Each connector supplies five hooks:
  `profileSchema` (typed field groups), `defaultProfileSettings`,
  `validateProfileSettings`, `applyProfileSettings` (write the box),
  `captureProfileSettings` (read the box back).
- **Routes**: `/api/servers/:id/profiles*` (list / schema / CRUD / apply / capture)
  — admin + CSRF.
- **Frontend**: a schema-driven **Profiles** panel in `servers.html`. The generic
  renderer handles field types `select` (+ `custom` combo / `addWorkshop`),
  `number`, `bool`, `text`, `textarea`, and `maplist` (ordered, optionally grouped).
  All game knowledge stays in the connectors.

## Per-game profiles (as built)

| Game | Profile bundles | Boot map/world | On-box write target |
|---|---|---|---|
| GMOD/TTT | map rotation (first entry = boot map) + workshop collection + `ttt_*` cvars + max players | `mapcycle[0]` | instance cfg + game cfg + `mapcycle.txt` + `gt_active_profile` |
| Factorio | active save + `server-settings.json` (name, max players, visibility, password, autosave) | `savename`/`startparameters` | server-settings.json + LGSM cfg + `gt_active_profile` |
| Counter-Strike | map (stock or `ws:<id>`) + mode + max players + hostname + raw extra-cvars | `host_workshop_map`/`map` | cs2server.cfg + `gamertown/active.cfg` + instance cfg |
| Minecraft | active world + `server.properties` subset (mode, difficulty, pvp, players, whitelist toggle, motd, …) | `level-name` | server.properties (SQLite pointer only) |

Operations that *create* content (Factorio Generate / Save As, MC Back Up world)
stay in the **Quick Settings** panel; Profiles and Quick Settings render together
(a game can have one or both). Offsite backups and the live console/RCON are their
own panels.

## Key behaviors

- **Apply = apply + restart.** The profile is written and the server restarted in
  one action, so config that only takes effect at boot (e.g. a GMOD workshop
  collection mount) actually applies.
- **Save vs Apply vs Save File:** *Save* stores edits to the selected profile (no
  restart); *Apply & Restart* makes it live; *Duplicate* forks a new profile;
  *Save File* (Raw Config Files section) writes one config file directly (advanced).
- **GMOD maps are collection-driven** (stock maps always; collection maps only when
  `wscollectionid` is set), grouped **Stock / Collection** in the selectors; a
  boot-map guard blocks a workshop map with no collection (would brick the boot).
- **CS workshop maps** show by name ("Assembly"); **＋ Workshop Map** adds one
  inline (id + name → catalog) and **Remove** deletes the selected one from the
  catalog (`DELETE /maps/:workshopId`) — no `ws:` typing.
- **Panel UX:** the card groups panels into three accent-coloured **sections** —
  **Configuration** (Profiles + Quick Settings + Raw Config Files), **Runtime**
  (live commands), **Backups** — with a shared **console** at the bottom; a section
  hides when none of its panels are visible. Plus per-panel "Loading…" placeholders,
  fresh per-server status on card mount, and per-tab re-mount.

## Not done (optional)

- **Live-vs-restart apply tagging** — let fields with a live RCON equivalent apply
  without a restart; show a per-field tag.
- **Startup-file drift badge** — surface when LinuxGSM / an SSH edit changed the
  startup files out from under the active profile (diff `captureProfile` vs stored).
- **Structured access-list editors** — MC whitelist/ops/bans + Factorio admins as
  add/remove widgets (today: whitelist *toggle* in-profile; player *lists* via the
  raw editor / in-game commands).
- **Minecraft RCON** (replace the tmux/log live path); CS/GMOD whitelist via
  SourceMod/ULX.
