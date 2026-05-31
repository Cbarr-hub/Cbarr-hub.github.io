# Server Control Panel — Expansion Plan

Status: **planned, not yet implemented**. This document is the implementation
spec for the next round of work on `/servers.html` + `/api/servers`. Read it
alongside [`INFRA.md`](INFRA.md) ("Game Server Control Panel") and
[`backend/README.md`](backend/README.md).

---

## 1. Goals (from the request)

A cleaner, less-confusing control panel with an explicit split between **startup
configuration** (applied on the next restart) and **runtime control** (applied
live to a running server). Per game:

**General**
- Clean, minimal layout; no ambiguity about what each field names or does.

**Counter-Strike 2**
- Enter a new Steam Workshop map by ID and have it **persist** in the catalog;
  the **Map Name** field appears **only while adding a new workshop ID**.
- **Rename** saved workshop maps.
- Save reusable **game-state configs** (e.g. bunnyhop) into a library, **select**
  one to deploy **alongside a map**, and **edit** them.
- Flow: pick **map + config → server runs**; while it runs, **send live CS2
  console commands** (reset, `sv_cheats`, bunnyhop toggles, free-form).
- The "Server Name" (hostname) box is confusing → **move it under Advanced**.
- Result: two clear config areas — **Startup** and **Runtime**.

**Factorio**
- Start a new map with custom config (**done**), save current world (**done**).
- **Back up** a world/save.

**Minecraft**
- **Start a new world.**
- **Back up** a world/save (already present — keep + add restore).

---

## 2. Locked decisions

| Question | Decision |
|---|---|
| Where saved workshop maps + game-state configs live | **Backend SQLite** (`gamertown.sqlite`) |
| How live no-restart commands reach a server | **In-guest RCON via the QEMU guest agent** (an rcon CLI runs inside each VM) |
| The CS "Server Name" / hostname field | **Keep, but move under an Advanced disclosure** |
| Deliverable | This committed markdown plan |

---

## 3. Architecture impact

Today connectors are constructed with `(server, client)` and own all game
knowledge; the service/route layers are game-agnostic (see
`backend/src/servers/`). Two capabilities get added without breaking that
contract:

1. **A persistence store** injected into connectors (3rd constructor arg) so CS
   can read/write its workshop catalog + config library in SQLite.
2. **A "live command" capability** on `BaseConnector` (`getLive`, `sendCommand`,
   `runLiveAction`) so the panel can drive a running server over RCON, with each
   game mapping its own actions.

Data flow is unchanged otherwise:

```
servers.html → db.js → /api/servers routes → service → connector → ProxmoxClient → PVE API
                                                   └→ serverStore (SQLite)   [new]
```

All game-specific strings (cvars, rcon commands, file paths) stay **inside
connectors**. The route/service layers and the frontend stay generic.

---

## 4. Phase 0 — Infra prerequisites (one-time, per VM)

These are guest/host setup steps the connectors assume. Document them in
`INFRA.md` and verify before Phase 3.

- **rcon CLI in CS (100) + Factorio (101) VMs.** Install a static Source-RCON
  client at `/usr/local/bin/rcon` (e.g. gorcon `rcon-cli`). Factorio and CS2
  both speak the Source RCON protocol; Minecraft will use the existing
  `tmux send-keys` path (no rcon binary needed there, though it can be added
  later).
- **CS2 rcon password.** Ensure `rcon_password "<secret>"` is set in
  `serverfiles/game/csgo/cfg/cs2server.cfg`. The connector reads it; if absent,
  the Runtime panel shows "RCON not configured" instead of failing.
- **Factorio rcon.** Already templated — `--rcon-port ${rconport}
  --rcon-password ${rconpassword}` (default port 34198). Set a real
  `rconpassword` in `lgsm/config-lgsm/fctrserver/common.cfg` (currently
  `CHANGE_ME`).
- **DB migration** (Phase 1) applied via `npm run migrate`.

> Security: rcon passwords stay **in-guest**. The backend reads them via
> `agentFileRead` at call time and never persists them. The free-form console is
> already admin-only (every `/api/servers` route is `requireAdmin` + CSRF).

---

## 5. Phase 1 — Persistence layer (SQLite)

**New migration** `backend/src/migrations/002_server_panel.sql`:

```sql
-- Persisted Steam Workshop map catalog (CS today; server_id keeps it generic).
CREATE TABLE IF NOT EXISTS server_workshop_maps (
  server_id   TEXT    NOT NULL,
  workshop_id TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (server_id, workshop_id)
);

-- Reusable game-state config snippets (bunnyhop, etc.).
CREATE TABLE IF NOT EXISTS server_configs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id  TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  body       TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (server_id, name)
);
```

Seed the existing hardcoded `WORKSHOP_MAPS` entry (Assembly `3071005299`) for
`counterstrike` so nothing regresses.

**New module** `backend/src/servers/store.js` — thin, pure-ish CRUD over the DB
(no Fastify, no Proxmox):

- `listWorkshopMaps(serverId)` / `addWorkshopMap(serverId, {workshopId, name})`
  / `renameWorkshopMap(serverId, workshopId, name)` / `deleteWorkshopMap(...)`
- `listConfigs(serverId)` (metadata only) / `getConfig(serverId, id)` /
  `saveConfig(serverId, {name, body})` / `updateConfig(...)` / `deleteConfig(...)`

**Wiring**: `createServerService({ client, publicHost, db })` →
`buildConnectors(client, store)` → `new Cls(server, client, store)`.
`BaseConnector` stores `this.store`; non-CS connectors simply ignore it.

---

## 6. Phase 2 — Counter-Strike startup overhaul

### 6.1 Backend (`connectors/counterstrike.js`)

- **Map catalog from DB**, not the hardcoded array. `getSettings()` builds the
  Map dropdown from stock `.vpk`s + `store.listWorkshopMaps('counterstrike')`.
  The active map is still derived from `host_workshop_map` / `map` in
  `cs2server.cfg`.
- **Add workshop map**: new connector method `addMap({workshopId, name})` →
  validates (`^\d{1,20}$`, name has no quotes/newlines) → `store.addWorkshopMap`.
- **Rename / delete**: `renameMap(workshopId, name)`, `deleteMap(workshopId)`.
- **Config library**: `listConfigs()`, `getConfig(id)`, `saveConfig`,
  `updateConfig`, `deleteConfig` delegate to the store.
- **Deploy config alongside map** (the key flow):
  - Maintain one managed file `cfg/gamertown/active.cfg` in the guest.
  - Ensure `cs2server.cfg` ends with exactly one `exec gamertown/active` line
    (idempotent — add once if missing).
  - On settings save, write the selected config's `body` into
    `cfg/gamertown/active.cfg` (empty file when "None"). Store the selected
    config id in instance var `gt_active_config` for UI pre-selection.
  - On restart, cs2 execs `cs2server.cfg` → execs `gamertown/active` → **map +
    config both apply**. (`agentFileWrite` is root-owned 644, readable by
    `miles` — same as existing config writes.)
- **Retire `gt_workshop_name`** as the source of truth (catalog owns names);
  keep reading it only as a fallback for an un-cataloged active map.

### 6.2 Routes (`routes/servers.js`) — CS catalog + config CRUD

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/servers/:id/maps` | list workshop catalog |
| POST | `/api/servers/:id/maps` | add `{workshopId, name}` |
| PATCH | `/api/servers/:id/maps/:workshopId` | rename `{name}` |
| DELETE | `/api/servers/:id/maps/:workshopId` | remove from catalog |
| GET | `/api/servers/:id/configs` | list config library (metadata) |
| GET | `/api/servers/:id/configs/:configId` | read one config `{name, body}` |
| POST | `/api/servers/:id/configs` | create `{name, body}` |
| PUT | `/api/servers/:id/configs/:configId` | update `{name?, body?}` |
| DELETE | `/api/servers/:id/configs/:configId` | delete |

The existing `PUT /:id/settings` stays the apply path; extend its body schema
with `configId` (selected config to deploy). Map selection still flows through
`map` / `workshopId`. Add service passthroughs and a `BAD_SETTING`/`NOT_FOUND`
error mapping for the new endpoints.

### 6.3 Frontend (bespoke CS startup panel in `servers.html`)

The generic schema renderer can't express conditional fields + inline add/rename,
so CS gets a small dedicated renderer (Factorio/Minecraft keep the generic
section renderer). Startup panel contents:

- **Map**: single dropdown = stock maps + saved workshop maps (by name).
- **+ Add workshop map**: reveals **Workshop ID** + **Map Name** inputs **only
  in add mode** (satisfies "naming section only shows when entering a new ID").
  Save → POST `/maps` → re-render with it selected.
- **Rename / delete** affordance per saved workshop map (PATCH/DELETE `/maps`).
- **Game Mode**: competitive / casual / deathmatch / wingman (unchanged).
- **Config**: dropdown from the library + **Manage** (open editor: name +
  textarea body, create/edit/delete) + a **None** option.
- **Max Players** (unchanged).
- **Advanced** (collapsed): **Server Name** (hostname) + the raw config-file
  editor moved here.
- One **Apply (restart to take effect)** button; note copy stays explicit.

---

## 7. Phase 3 — Runtime / live command surface (RCON)

### 7.1 Connector capability (`BaseConnector`)

```
getLive()           → { available: bool, reason?: string,
                        actions: [{ key, label, danger? }], commandHint?: string }
sendCommand(cmd)    → { output: string }      // free-form, RCON/console
runLiveAction(key)  → { output: string }      // curated action → game command(s)
```

Default `getLive()` returns `{ available:false, reason:'no live control' }`.
**Use `runCommand` (argv array), never `runShell` (string)** for live commands,
so the user-supplied command text can't break out into the shell:

```
['/usr/sbin/runuser','-u','miles','--','/usr/local/bin/rcon',
 '-a','127.0.0.1:<port>','-p','<pass>', cmd]
```

Read `<pass>`/`<port>` from the guest config at call time. Validate `cmd`:
non-empty, length ≤ 512, strip CR/LF.

### 7.2 Per-game implementations

- **CS2** (`available` when `rcon_password` is set): curated actions —
  - `restart_round` → `mp_restartgame 1`
  - `cheats_on` / `cheats_off` → `sv_cheats 1` / `sv_cheats 0`
  - `bunnyhop_on` → `sv_cheats 1; sv_autobunnyhopping 1; sv_enablebunnyhopping 1;
    sv_staminamax 0; sv_airaccelerate 1000` · `bunnyhop_off` → reset those
  - `reload_map` → `changelevel <current>` (full state reset)
  - `apply_active_config` → write selected library config to
    `cfg/gamertown/active.cfg` then rcon `exec gamertown/active` (**applies a
    saved config live**, no restart). Free-form box covers any other CS2 command.
- **Factorio** (rcon-port 34198): free-form console (Lua/console commands) plus a
  couple of curated actions (`/server-save`, `/players`).
- **Minecraft**: reuse `tmux send-keys -t minecraft '<cmd>' Enter` (already used
  for `save-all`); curated: `save-all`, `list`, plus free-form. (No output
  capture over tmux — note that in the UI, or enable Minecraft RCON later.)

### 7.3 Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/servers/:id/live` | availability + curated action list |
| POST | `/api/servers/:id/live/command` | `{ command }` free-form |
| POST | `/api/servers/:id/live/action` | `{ action }` curated |

Service passthroughs + a `NO_RCON` (503/501) error mapping.

### 7.4 Frontend — Runtime panel

- Rendered per card, **enabled only when status is `running`** and
  `live.available`; otherwise shows the `reason`.
- Curated **action buttons** (from `getLive().actions`; `danger` ones confirm).
- **Apply saved config live**: config dropdown + "Apply now".
- **Console**: command input + a scrolling output log (reuses the `pre.out`
  styling).

---

## 8. Phase 4 — Factorio + Minecraft gaps

- **Minecraft "Generate New World"** (new `getSettings` section + `setSettings`
  branch in `connectors/minecraft.js`): fields — Name (`level-name`), Seed
  (`level-seed`), World Type (`level-type`: normal/flat/large_biomes/amplified),
  optional Difficulty / Gamemode. Setting `level-name` to a fresh value + restart
  generates the world. Validate name `^[a-zA-Z0-9_-]{1,64}$` (matches existing).
- **Factorio "Back Up World"**: copy the active save (or latest `_autosave*`) to
  `serverfiles/backups/<name>_<timestamp>.zip`. Distinct from "Save As" (which
  makes a *loadable* named save). No restart.
- **Minecraft backup**: keep current "Back Up Current World As"; add a **Restore**
  (copy a backup dir back over `level-name`, restart) for symmetry.
- Both backup flows list existing backups so they're restorable.

---

## 9. Phase 5 — UI cleanup / minimal redesign

Restructure each server card into three labelled panels (keep the retro CSS):

1. **Startup** — "applies on next restart": map/world + mode + config + players +
   (Advanced: server name, raw config).
2. **Runtime** — "live, server must be running": action buttons + apply-config +
   console.
3. Power/status/join bar stays at top; **Update** stays in the header.

Cleanups: conditional Map-Name field, hostname under Advanced, consistent verbs
("Apply" vs "Save As" vs "Back Up" vs "Generate"), and explicit "takes effect on
restart" vs "live now" copy on every action. Consider extracting the card JS into
`servers-ui.js` to keep `servers.html` readable (optional).

---

## 10. Phase 6 — Tests + docs

- **Unit tests** (`backend/test/servers.test.mjs`, fake client + in-memory DB):
  store CRUD; CS catalog build; `active.cfg` exec-line idempotency; config
  deploy on save; rcon command **argv construction + injection safety**;
  Minecraft new-world props; backup copy commands.
- **Docs**: update `INFRA.md` (rcon setup, new endpoints, `gamertown/active.cfg`
  convention), `backend/README.md` (API table), and `CLAUDE.md` (gotchas: rcon
  password location, argv-not-shell rule, active-config exec line).

---

## 11. Security & correctness notes

- Every `/api/servers` route is **admin-only + CSRF**; keep that on all new
  endpoints.
- **Never build live-command shell strings** — argv only (Phase 3.1).
- VMIDs still come only from the registry; ids in paths stay `^[a-z0-9-]{1,32}$`.
- rcon passwords are read on demand and **never** returned to the client or
  stored in SQLite.
- Validate every persisted name (`^[a-zA-Z0-9_-]{1,64}$`) and config body length;
  config bodies are exec'd by the game, so they're admin-trusted but still
  length-capped.
- Backups/new-worlds copy potentially large files — keep the generous agent-exec
  timeouts already used for Save As / Generate.

---

## 12. Suggested implementation order

1. Phase 1 (DB + store + wiring) — unblocks everything, low risk.
2. Phase 2 (CS startup: catalog + config deploy) — the biggest UX win.
3. Phase 3 (RCON runtime surface) — needs Phase 0 rcon install.
4. Phase 4 (Minecraft new world, Factorio/Minecraft backups).
5. Phase 5 (UI redesign pass) — fold in as each phase lands, finalize here.
6. Phase 6 (tests + docs) — alongside each phase, not just at the end.

Each phase is independently shippable and leaves the panel working.
