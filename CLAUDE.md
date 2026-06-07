# Gamertown — Claude Code Context

## Project

Gamertown is a live web app for a friend group: forum, gambling/games, game server control panel.
Stack: **Fastify + SQLite + Caddy**, deployed as a **Docker stack on the keeper** — Proxmox VM 106 `gamertown-docker` (192.168.1.241). *(Migrated off the old Proxmox LXC CT 103 + per-game VMs on 2026-06-04.)*

All prose docs live in [`docs/`](docs/) (index: [`docs/README.md`](docs/README.md)):
Full infra details → [`docs/infrastructure.md`](docs/infrastructure.md)  
Disaster recovery → [`docs/disaster-recovery.md`](docs/disaster-recovery.md)  
Backend API reference → [`docs/backend.md`](docs/backend.md)  
Design system → [`docs/design-system.md`](docs/design-system.md)  
Local dev (Windows/macOS/Linux) → [`docs/local-dev.md`](docs/local-dev.md) — **one command**: `gt … dev --fresh` (`tools/gt.ps1` / `tools/gt.sh`) does secrets + DB + full stack + health; `gt … dev --prod-like` rehearses the real deploy on existing data. Dispatcher reads `tools/gt-modes.conf` and calls the primitives `tools/setup.*` (secrets from R2) + `tools/dev.*` (full stack, localhost/self-signed, live reload) + `tools/db-restore.*` (app DB for login).

---

## Repo layout

```
/                       static site root (Caddy serves this)
backend/                Fastify backend
  src/
    routes/             API route handlers
    servers/            game server control (service, connectors, registry)
      connectors/docker/  Docker-backed game connectors
    docker/             Docker API client (game-server control transport)
    cli.js              user management CLI
  data/                 SQLite DB + session key (gitignored)
  .env                  runtime config (gitignored)
docker-compose.yml      app + Caddy stack
servers.compose.yml     the 5 game-server containers
docs/                   all project documentation (infra, DR, local-dev, backend, design)
tools/                  backup/restore scripts (db-*, secrets-*)
tests/                  test suite
```

---

## Critical infra facts

| Thing | Value |
|---|---|
| Host ("keeper") | Proxmox **VM 106** `gamertown-docker`, 192.168.1.241, MAC `bc:24:11:62:f5:5d` — a Docker host. The PVE box `pve` (192.168.1.109) is just the hypervisor; no Docker runs on it. |
| Enter the keeper | `ssh root@192.168.1.241` (passwordless from `pve`) or `qm guest exec 106 -- …` |
| Repo checkout | `/root/gamertown` on the keeper (branch `main`) |
| Stack | `docker compose` project `gamertown`: `docker-compose.yml` + `servers.compose.yml` (+ project `.env`) |
| App + proxy | `gamertown-app-1` (Fastify, `:3000` internal) behind `gamertown-caddy-1` (Caddy, `:443`) — separate containers |
| Database | SQLite in volume `gamertown_gt-data` → `/var/lib/docker/volumes/gamertown_gt-data/_data/gamertown.sqlite` |
| Secrets | `/etc/gamertown/secrets.env` (app/caddy) + `/root/gamertown/.env` (games) — see [`docs/disaster-recovery.md`](docs/disaster-recovery.md) |
| TLS / edge | `gamertown.solutions` via **Cloudflare** → BGW210 `:443` forward to the keeper; **Cloudflare Origin cert** + Caddy `forward_auth` gate (no tunnel) |
| Public IP | `104.177.95.216` (AT&T dynamic — may change) |

**Deploy = on the keeper.** `/root/gamertown` is the only deployment checkout; a `git push` to GitHub does **not** update it — `git pull` on the keeper, then rebuild/restart the affected containers. *(The old host-clone/CT-103 two-clone split is retired.)*

---

## Common operations

All commands run **on the keeper** (`ssh root@192.168.1.241`, passwordless from `pve`).
`COMPOSE="docker compose -f docker-compose.yml -f servers.compose.yml"` (run from `/root/gamertown`).

```bash
# Deploy a code update (PREFERRED: backup-first, fail-fast, rollback-capable)
cd /root/gamertown && tools/gt.sh prod   # DB->predeploy/ backup (abort on fail) -> reset to
                                         # origin/main -> up -d --build -> health check
#   tools/gt.sh prod --dry-run           # print every resolved command, change nothing
#   tools/gt.sh prod --rollback          # restore predeploy DB + checkout last SHA + redeploy
# Manual equivalent (no pre-deploy backup):
#   git pull && $COMPOSE up -d --build   # rebuilds changed images, recreates affected containers

# Restart / logs (services: app, caddy, minecraft, gmod, prophunt, counterstrike, factorio)
$COMPOSE restart app
docker logs -f gamertown-app-1
docker logs -f gamertown-caddy-1

# Health check (through Cloudflare)
curl -s https://gamertown.solutions/api/health

# Database (host sqlite3 against the volume)
sqlite3 /var/lib/docker/volumes/gamertown_gt-data/_data/gamertown.sqlite

# Migrations / user management (inside the app container)
docker exec -it gamertown-app-1 npm run migrate
docker exec -it gamertown-app-1 node src/cli.js list-users
```

---

## Known gotchas

> **Post-migration framing (2026-06-04):** all five games + the app run as **Docker containers on the keeper**, not Proxmox VMs — controlled via `docker` + **RCON-over-TCP** (not `pct`/`qm`/in-guest `python3`). Each game uses a different upstream image, so layouts differ: **GMOD + Prop Hunt** are **LinuxGSM-in-a-container** (`docker/gmod`; paths rooted at `/data` — read old "VM 104/105" and `/home/miles/<game>server` as the `gmod`/`prophunt` containers under `/data`), **Factorio** is `factoriotools/factorio` (`/factorio`), **CS2** is `joedwards32/cs2`, **Minecraft** is `itzg/minecraft-server` (`/data`). The GMOD/TTT/PH gotchas below still hold (same srcds under the hood, paths under `/data`); per-image specifics are noted inline. The app no longer talks to Proxmox at all — the PVE API client/token and `pct`/`qm` control path were removed at the migration (retired Proxmox topology was removed from the tree on 2026-06-05; recover `INFRA_LEGACY.md` from git history if needed).

- **Port 80 blocked:** AT&T BGW210-700 reserves port 80 internally — cannot forward it. HTTPS only (443). Future Let's Encrypt setup requires DNS-01 challenge via Cloudflare, not HTTP-01.
- **Factorio active save:** the `factoriotools/factorio` container always loads `/factorio/saves/_active.zip` (`SAVE_NAME=_active` in `servers.compose.yml`). Switching worlds = copy the chosen save over `_active.zip` and restart (the panel's profile world-picker / **Save As** does this). The old LinuxGSM `startparameters`/`savename`/`--start-server` model no longer applies.
- **Factorio 2.0 MapGenSize:** valid values are `none`, `very-low`, `low`, `normal`, `high`, `very-high`. `large`/`very-large` were removed in 2.0 and cause a hard crash.
- **GMOD/TTT game cfg is `cfg/gmodserver.cfg`:** the `gmod` container (LinuxGSM) launches srcds with `+servercfgfile gmodserver.cfg`, so TTT cvars + `rcon_password` live in `/data/serverfiles/garrysmod/cfg/gmodserver.cfg` — NOT a `server.cfg`. Don't confuse it with the identically-named LinuxGSM *instance* cfg at `/data/lgsm/config-lgsm/gmodserver/gmodserver.cfg` (shell vars: `gamemode`, `defaultmap`, `maxplayers`, `port`, `wscollectionid`, `gslt`).
- **TTT map autoplay needs `ttt_always_use_mapcycle 1`:** maps in `garrysmod/mapcycle.txt` only rotate (after `ttt_round_limit` rounds / `ttt_time_limit_minutes`) when this cvar is set. The engine reads `garrysmod/mapcycle.txt`, not the `cfg/` copy LinuxGSM ships.
- **GMOD port is 27066, not 27015/27016:** the CS forward already claims 27000–27039 on the router, so GMOD binds + forwards 27066. The connector's RCON port and the registry join-string port must stay in sync.
- **GMOD workshop maps need a GSLT + CS:S mount:** the `GMOD_GSLT` env (Steam appid 4000; seeded into the instance cfg by the `docker/gmod` image) makes `wscollectionid` downloads reliable; CS:S content (skipped when `SKIP_CSS=1`) is mounted via `garrysmod/cfg/mount.cfg` so TTT maps aren't missing textures. `terrortown` itself is built into GMOD (boots on `gm_construct` with no workshop). GSLTs live in the project `.env` (`GMOD_GSLT`/`PROPHUNT_GSLT`) — see `secrets.env.example`.
- **GMOD workshop maps mount ONLY at boot, from the collection:** `wscollectionid` (`host_workshop_collection`) is read at server *start* — GMOD downloads the collection's addons to `serverfiles/garrysmod/cache/srcds/*.gma` and **mounts** them for that session. An **empty collection mounts 0 addons**, so its maps won't load even though the `.gma` files sit in the cache (cache = download cache, NOT an install). Therefore: (a) setting `defaultmap` to a workshop map with no collection set **bricks the boot** (`No such map … / Server is not running or has no active map!`); (b) live `changelevel` only reaches maps mounted at the **last** boot, so changing the collection/rotation needs a **restart**. Only `gm_construct`/`gm_flatgrass` are always present. Workshop `.bsp` names are **lowercase** even when the Workshop *title* is mixed-case (title "ttt_Clue_se" → map `ttt_clue_se`).
- **GMOD map discovery = `garrysmod/maps/` ONLY (single source of truth).** GMOD scatters downloaded workshop content across **two locations/formats** — legacy addons as `cache/srcds/<id>.gma` and modern ones as `serverfiles/steam_cache/content/4000/<id>/*.gma` — so no single cache holds every map. The connector's `syncMaps()` extracts each downloaded collection map's `.bsp` (via `serverfiles/bin/gmad_linux`; these TTT maps are self-contained packed `.bsp`) into `garrysmod/maps/`, and `installedMaps()` reads **only** that dir. So a newly-added collection map appears in the panel only after the **"Sync from Collection"** action (flow: add on Steam → Restart Hosting to download → Sync to install). Removal from the collection is **not** auto-uninstalled (additive).
- **Startup-config "Profiles" (servers panel):** named structured startup configs per server, stored in SQLite (`server_profiles` + `server_active_profile`, migration 003). A profile is what the server *boots as*; live RCON/console commands are ephemeral and never written back. Each connector implements `profileSchema`/`defaultProfileSettings`/`validateProfileSettings`/`applyProfileSettings`/`captureProfileSettings` on `BaseConnector` (generic lifecycle = list/get/create/update/delete/apply/capture + an auto-seeded "Default"). **All five games (GMOD, Prop Hunt, Factorio, CS, Minecraft) are wired for profiles.** For GMOD the rotation's **first map is the boot map** (no separate field), and the panel's **Apply = apply config + restart** so the collection actually mounts. The panel shows a **Profiles** panel (config) AND a **Quick Settings** panel (operations like Factorio Save As / Generate) together — a game can have one or both; a game wired for profiles trims its `getSettings` so config doesn't double-render.
- **Servers panel power = the container model.** `servers.html` is a **fleet deck** (per-game tiles with live CPU/RAM + a fleet total) over a per-game management card. Power controls are container-level — **Start · Restart · Stop · Force Stop · Update · Refresh** — with **no** separate "Game Service" buttons (the container *is* the game, so on **every** Docker game `startGame`/`stopGame`/`restartGame` **alias to container power** — start/shutdown/reboot — never `BAD_ACTION`). GMOD/PH alias via `dockerizeGmod`; CS/Factorio/Minecraft alias on `DockerBaseConnector`. **Update the game client is in-panel for all five games** (re-added 2026-06-05; shown only while the container is running): GMOD/PH run LinuxGSM `./gmodserver update`, CS runs SteamCMD `+app_update 730`, both in-container; Minecraft/Factorio `update()` restart the container so the image re-resolves/re-downloads its configured version (a true Factorio version bump still needs a host `docker compose pull`). All four recipes need host validation. **Card layout: Runtime section sits ABOVE Configuration** (live controls first, persistent config below). **Apply & Restart** reboots the container (which also remounts a GMOD workshop collection). **Backups aren't an app feature at all** — the app holds no R2 keys, so there's no backup UI or route; production backups (app DB + Factorio save + Minecraft world → R2) run from the **host systemd timer** only (see [`docs/disaster-recovery.md`](docs/disaster-recovery.md)). Container power + update model codified in `backend/test/docker.test.mjs`.
- **Runtime panel: binary toggles are buttons, ranges are sliders.** `getLive()` returns `actions` (genuinely binary toggles / instant commands → buttons) AND `controls` (continuous cvars → sliders, pushed via `runLiveAction(key, value)`). For GMOD + Prop Hunt the slider controls are **gravity** (`sv_gravity`), **player speed** (`hl2_normspeed`, sprint = 1.5×), and **game speed** (`host_timescale`) — shared `GMOD_LIVE_CONTROLS` / `gmodRangeCmd` in `gmod.js`, clamped to bounds; cheats/bunnyhop stay toggle buttons. The old `lowgrav_on/off`, `speed_on/off`, `slowmo_on/off` action pairs were replaced by these sliders.
- **CS settings (counterstrike): live-apply, collection import, auto names.** CS is the one game whose profile **Apply pushes LIVE over RCON, NOT by restart** (a restart reverts to the compose env) — so `profileGroups` returns an `apply: { mode:'live', label, confirm, note }` descriptor that the panel reads to relabel the button (**▶ Apply Live**) and **skip the reboot**. `maxPlayers` is **not** a CS profile field (env-only / `CS2_MAXPLAYERS`; Apply can't change it). The workshop-map catalog now supports **collection import** (`POST /:id/maps/collection` → `importCollection`) and **auto-fetched names** (omit `name` on `POST /:id/maps` → backend pulls the Workshop title) via the **keyless** Steam endpoints in `backend/src/servers/steam-workshop.js` (`ISteamRemoteStorage/GetCollectionDetails` + `GetPublishedFileDetails`; an optional `STEAM_API_KEY` is passed through if set but never required).
- **Prop Hunt = the `prophunt` container, port 27067.** Same `gamertown-gmod` image as TTT (built from `docker/gmod/Dockerfile`), but `GAMEMODE=prop_hunt` with its **own** `PROPHUNT_GSLT` so it runs alongside TTT. `PropHuntConnector` extends `GmodConnector` (paths derive from `gsmDir`=`/data`; `mapPrefixes=['ph_','gm_']`; RCON on the registry game port). **Workshop content mounts from the public Steam collection `3737190377`** (`wscollectionid` / `PROPHUNT_WORKSHOP_COLLECTION`) — GMOD downloads + mounts it at boot. The **Prop Hunt: X2Z** gamemode addon ships the `prop_hunt` (+ `base_phx`) folder, so `gamemode=prop_hunt` loads; the 7 `ph_` maps + taunt packs + loadout manager come along, and clients auto-download via the collection. `applyProfileSettings` deliberately does **NOT** write `wscollectionid` (so Apply can't break the mount). Edit X2Z config via the panel's **Raw Config** editor: `server.cfg`/`active.cfg` for `ph_`/`phx_` cvars, `lgsm.cfg` for the collection id/ports, plus X2Z's `phx-loadout`/`phx-admins` data files (chowned back to the in-container `miles` user after write). NOTE: `prop_hunt` is not built into GMOD (only base/sandbox/terrortown ship), so the collection mount is required to boot PH. **`3736674438` is a working TTT *maps* collection** (separate from PH) — verified 2026-06-04 to mount 5 `ttt_` maps (ttt_clue_se, ttt_diescraper, ttt_dolls, ttt_minecraft_b5, ttt_waterworld).
- **Dev game-client connect = the host LAN IP, NOT `127.0.0.1` (dev-only quirk).** Joining a dev game server from a client on the **same machine** fails two ways that don't exist on prod: (1) a Source/GMOD client binds its socket to the host **LAN interface** and on Windows physically can't send to `127.0.0.1` (loopback is a separate interface) — packets are dropped before Docker sees them (verified by netns `tcpdump`: 0 packets on a `127.0.0.1` connect, fine on the LAN IP); (2) a VAC-secure server rejects the Steam-auth ticket once it's NAT'd through the Docker bridge. So the dev `gmod`/`prophunt` containers boot **LAN + insecure** (`LAN_INSECURE=1` in `docker-compose.dev.yml` → entrypoint appends `+sv_lan 1 -insecure` to LinuxGSM's own `startparameters` template, so **GSLT + Workshop are preserved**), and you `connect <LAN-IP>:27066`/`:27067` — set `DEV_PUBLIC_HOST=<LAN IP>` in `.env.local` so the panel's join string emits it. The GSLT/Steam-identity is **not** the cause (the client does plain direct UDP); the web panel/API + RCON control + session collector all work over the Docker network regardless. **Prod is untouched** (never `LAN_INSECURE`; public players auth through Steam to the public IP normally). Full detail → [`docs/local-dev.md`](docs/local-dev.md).
- **Offsite backups → Cloudflare R2 (`gamertown-backups`, remote `r2`) are LIVE — host-driven.** A **host systemd timer** (`gt-db-backup.timer`, **weekly Mon 04:00** → `/usr/local/bin/gt-backup.sh`; vendored at [`tools/gt-backup.sh`](tools/gt-backup.sh) + [`tools/systemd/`](tools/systemd/)) pushes the **app DB** (`app/`, keep 7), the **Factorio active save** (`factorio/`, keep 3), and the **Minecraft world** (`minecraft/`, ~5 GB gz, keep 3 — flushed via the container's `rcon-cli` for a consistent snapshot). The **age-encrypted secret bundle** (`secrets/`) is on-demand (`tools/secrets-backup.sh`). rclone runs as host **root** (keys in `/root/.config/rclone/rclone.conf`); the repo/app/**containers never hold R2 keys** — so backups are the host timer's job, **not** an in-panel feature (the app reaches the engine only through the scoped socket-proxy, with no path to R2). **rclone must be ≥ ~1.66 (we run 1.74.2)** — stock **1.60.1 returns `501 NotImplemented` on R2 `rcat`**. Prune keeps the newest N by the `_YYYYMMDD_HHMMSS` **in the name**, NOT object ModTime. Full backup map + recovery → [`docs/disaster-recovery.md`](docs/disaster-recovery.md).
- **Player-session tracking is HOST-side, not the app.** A long-running host **systemd service** (`gt-session-tracker.service` → [`tools/gt-session-tracker.mjs`](tools/gt-session-tracker.mjs), vendored with [`tools/systemd/`](tools/systemd/)) records who joins/leaves each server, **independent of the website** (the app only *reads* the rows, for the servers panel's **standalone "Events" section** — NOT a per-game tab). **Hybrid collection:** it **tails `docker logs -t`** for **Minecraft + Factorio** (accurate join/leave times; Minecraft also yields the Mojang UUID) and **RCON-polls `status` every 60s** for the **Source games** (GMOD/Prop Hunt/CS2 — ±60s; GMOD/PH give a SteamID64, **CS2 is name-only** because its `status` redacts SteamIDs). It's pure Node (imports the dep-free `registry.js` + `rcon-tcp.js` + `connectors/online-parse.js`) and writes via the host `sqlite3` CLI — so it needs **`node` + `sqlite3` on the keeper** and **full `docker` access** (the app can't, via the scoped socket-proxy). **Schema (migration 005):** sessions live in `server_sessions` + a global `players` roster (the cross-game whitelist seed: one SteamID64 spans the 3 Source games; null-uid CS2 rows get no `players` row); the 5 game *servers* are rows in the **existing `games` table tagged `hosted=1`** (seeded from the registry on app boot), so `/api/games` filters `hosted=0` to keep the party-games picker clean. Store write-SQL (`store.js`) is the tested canonical copy; the collector mirrors it via `sqlite3`. **Validated live in the dev stack (2026-06-06):** CS2's `status` is a name-only **`---players---` block** (single-quoted names, *redacted* SteamID, `BOT` in the time column, empty `''` connecting slots) — nothing like legacy srcds, so `parseSourceStatus` **dispatches** a CS2 branch vs the GMOD/PH `#userid "name" STEAM_…` rows. The collector sets the sqlite busy timeout with the **`.timeout` dot-command, NOT `PRAGMA busy_timeout=N;`** (that pragma emits a value row that pollutes `-json` reads → phantom `{timeout}` rows / broken `JSON.parse`), and needs host **`sqlite3` ≥ 3.38** (`unixepoch()` + `-json`; probed at startup, fail-fast). Minecraft (UUID) + Factorio (`[JOIN]` on stdout) log formats confirmed against the real containers.

---

## Environment / secrets

Runtime config is injected by Compose, **not** committed. Two host files (neither in git):

- **`/etc/gamertown/secrets.env`** → app + Caddy (`env_file`): `SITE_ADDRESS`,
  `CADDY_TLS`, `MINECRAFT_RCON_PASSWORD`, `CS2_RCON_PASSWORD`, `GMOD_RCON_PASSWORD`,
  `PROPHUNT_RCON_PASSWORD`. **age-backed-up** to R2.
- **`/root/gamertown/.env`** (Compose project) → game containers: `GMOD_GSLT`,
  `PROPHUNT_GSLT`, `GMOD_WORKSHOP_COLLECTION`, `MC_LEVEL`, `SKIP_CSS`, + duplicate
  RCON passwords. **Not** backed up (GSLTs regenerable at steamgameservers.com / appid 4000).

The app container also sets `HOST=0.0.0.0` (so Caddy reaches it across the compose
network) + `NODE_ENV=production`; `backend/.env` still supplies the in-container
defaults (`PORT`, `DB_PATH`, `SESSION_KEY_PATH`). `secrets.env.example` documents the
shape. The old `PVE_*` token keys are **retired** (the app is pure-Docker now). Full
secret map + recovery → [`docs/disaster-recovery.md`](docs/disaster-recovery.md).
