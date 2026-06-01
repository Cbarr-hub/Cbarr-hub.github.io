# Server Control Panel — Status

Implementation record for `/servers.html` + `/api/servers`. The "how it works"
detail now lives in [`INFRA.md`](INFRA.md) ("Game Server Control Panel") and
[`backend/README.md`](backend/README.md); this file tracks **phase status and
what's left**.

> **Superseded:** the per-game *startup-config* model below (Quick Settings, the CS
> map catalog + raw config library) was reframed into named **Profiles** for all
> four games — see [`SERVER_PROFILES_PLAN.md`](SERVER_PROFILES_PLAN.md). This doc
> remains the record of the original panel/RCON/backups build.

## Goal

A control panel with an explicit split between **Startup configuration** (applies
on next restart) and **Runtime control** (applies live over RCON), for each game
VM. Locked decisions: saved maps/configs live in **backend SQLite**; live
commands reach servers via **in-guest RCON over the QEMU guest agent**; the CS
hostname field lives under an **Advanced** disclosure.

## Phase status

| Phase | What | Status |
|---|---|---|
| 1 | Persistence layer — `migrations/002`, `servers/store.js`, connector wiring | ✅ done |
| 2 | CS startup overhaul — DB-backed workshop-map catalog + config library, deploy config alongside map via `cfg/gamertown/active.cfg`, bespoke CS panel | ✅ done |
| 3 | Runtime / live RCON — `getLive`/`sendCommand`/`runLiveAction`, in-guest Python Source-RCON (`rcon.js`), curated per-game actions, console panel | ✅ done |
| 3.5 | Runtime follow-ups — Restart Hosting, live change-map (CS), live config apply, unified console + spinners, RCON read-until-quiet | ✅ done |
| 4 | Backups — **offsite to Cloudflare R2** via in-guest `rclone` (Factorio + Minecraft); create/list/restore/delete; app never holds R2 creds | ✅ done (code) |
| 5 | UI cleanup — three labelled panels (Startup / Runtime / power bar), consistent verbs, "restart vs live" copy | ◑ largely landed; final polish optional |
| 6 | Tests + docs — `store.test.mjs`, `servers.test.mjs`; INFRA/README/CLAUDE updates | ✅ done |

## Architecture (unchanged contract)

```
servers.html → db.js → /api/servers routes → service → connector → ProxmoxClient → PVE API
                                                   └→ serverStore (SQLite)
```

All game-specific strings (cvars, RCON commands, file paths) stay **inside
connectors**; the route/service/frontend layers stay generic. VMIDs only ever
come from `registry.js`. Every `/api/servers` route is **admin-only + CSRF**.
Live commands are built as **argv arrays, never shell strings**; RCON passwords
are read in-guest on demand and never persisted or returned to the client.

## Still pending / one-time setup

- **R2 backups need per-VM rclone config** (Factorio 101 + Minecraft 102) before
  the Backups card works — see `INFRA.md` → "Offsite backups (rclone → R2)".
  Until done the endpoint returns `{ available:false }` and the panel says so.
- **Factorio RCON password** is still LinuxGSM's `CHANGE_ME` until overridden in
  `common.cfg`; live commands need a real `rconpassword`.
- **Phase 5 final polish** — optional; consider extracting card JS out of
  `servers.html` into `servers-ui.js` for readability.
