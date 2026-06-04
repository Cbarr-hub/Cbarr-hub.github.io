# Gamertown — Claude Code Context

## Project

Gamertown is a live web app for a friend group: forum, gambling/games, game server control panel.
Stack: **Fastify + SQLite + Caddy**, deployed as a **Docker stack on the keeper** — Proxmox VM 106 `gamertown-docker` (192.168.1.241). *(Migrated off the old Proxmox LXC CT 103 + per-game VMs on 2026-06-04.)*

Full infra details → [`INFRA.md`](INFRA.md)  
Disaster recovery → [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md)  
Backend API reference → [`backend/README.md`](backend/README.md)  
Design system → [`GAMERTOWN_DESIGN_PLAN.md`](GAMERTOWN_DESIGN_PLAN.md)

---

## Repo layout

```
/                       static site root (Caddy serves this)
backend/                Fastify backend
  src/
    routes/             API route handlers
    servers/            game server control (service, connectors, registry)
      connectors/docker/  Docker-backed game connectors (current)
    proxmox/            PVE API client (legacy backend, kept for the seam)
    docker/             Docker API client (current backend)
    cli.js              user management CLI
  data/                 SQLite DB + session key (gitignored)
  .env                  runtime config (gitignored)
docker-compose.yml      app + Caddy stack
servers.compose.yml     the 5 game-server containers
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
| Stack | `docker compose` project `gamertown`: `docker-compose.yml` + `servers.compose.yml` + `mc-mem.override.yml` (+ project `.env`) |
| App + proxy | `gamertown-app-1` (Fastify, `:3000` internal) behind `gamertown-caddy-1` (Caddy, `:443`) — separate containers |
| Database | SQLite in volume `gamertown_gt-data` → `/var/lib/docker/volumes/gamertown_gt-data/_data/gamertown.sqlite` |
| Secrets | `/etc/gamertown/secrets.env` (app/caddy) + `/root/gamertown/.env` (games) — see [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) |
| TLS / edge | `gamertown.solutions` via **Cloudflare** → BGW210 `:443` forward to the keeper; **Cloudflare Origin cert** + Caddy `forward_auth` gate (no tunnel) |
| Public IP | `104.177.95.216` (AT&T dynamic — may change) |

**Deploy = on the keeper.** `/root/gamertown` is the only deployment checkout; a `git push` to GitHub does **not** update it — `git pull` on the keeper, then rebuild/restart the affected containers. *(The old host-clone/CT-103 two-clone split is retired.)*

---

## Common operations

All commands run **on the keeper** (`ssh root@192.168.1.241`, passwordless from `pve`).
`COMPOSE="docker compose -f docker-compose.yml -f servers.compose.yml -f mc-mem.override.yml"` (run from `/root/gamertown`).

```bash
# Deploy a code update
cd /root/gamertown && git pull
$COMPOSE up -d --build                  # rebuilds changed images, recreates affected containers

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

> **Post-migration framing (2026-06-04):** all five games + the app now run as **Docker containers on the keeper**, not Proxmox VMs. The game-config gotchas below still hold — same LinuxGSM / srcds / Minecraft under the hood — but read "VM 104/105" as the `gmod`/`prophunt` **containers**, in-guest paths like `/home/miles/<game>server` as paths **inside that container** (rooted at `/data`), and control as `docker` + **RCON-over-TCP** rather than `pct`/`qm`/in-guest `python3`. The pure-Proxmox items (`pct`/`qm`, **`safe.directory`**, **PVE API token privsep**) are **legacy** — the app no longer talks to Proxmox.

- **Port 80 blocked:** AT&T BGW210-700 reserves port 80 internally — cannot forward it. HTTPS only (443). Future Let's Encrypt setup requires DNS-01 challenge via Cloudflare, not HTTP-01.
- **Factorio active save:** controlled by `startparameters` in `lgsm/config-lgsm/fctrserver/fctrserver.cfg`, NOT `savename`. Override the full `--start-server` line when switching worlds.
- **Factorio 2.0 MapGenSize:** valid values are `none`, `very-low`, `low`, `normal`, `high`, `very-high`. `large`/`very-large` were removed in 2.0 and cause a hard crash.
- **PVE API token privsep:** with `privsep=1`, effective rights = intersection of token ACLs AND user ACLs — both must be granted on each VM path.
- **`safe.directory` flag:** required when running `git` as root via `pct exec` because the repo is owned by the `gamertown` service user.
- **GMOD/TTT game cfg is `cfg/gmodserver.cfg`:** GMOD (VM 104) launches srcds with `+servercfgfile gmodserver.cfg`, so TTT cvars + `rcon_password` live in `serverfiles/garrysmod/cfg/gmodserver.cfg` — NOT a `server.cfg`. Don't confuse it with the identically-named LinuxGSM *instance* cfg at `lgsm/config-lgsm/gmodserver/gmodserver.cfg` (shell vars: `gamemode`, `defaultmap`, `maxplayers`, `port`, `wscollectionid`, `gslt`).
- **TTT map autoplay needs `ttt_always_use_mapcycle 1`:** maps in `garrysmod/mapcycle.txt` only rotate (after `ttt_round_limit` rounds / `ttt_time_limit_minutes`) when this cvar is set. The engine reads `garrysmod/mapcycle.txt`, not the `cfg/` copy LinuxGSM ships.
- **GMOD port is 27066, not 27015/27016:** the CS forward already claims 27000–27039 on the router, so GMOD binds + forwards 27066. The connector's RCON port and the registry join-string port must stay in sync.
- **GMOD workshop maps need a GSLT + CS:S mount:** set a GSLT token (appid 4000) in the instance cfg for `wscollectionid` downloads to work reliably; CS:S content lives at `serverfiles/css-content` mounted via `garrysmod/cfg/mount.cfg` so TTT maps aren't missing textures. `terrortown` itself is built into GMOD (boots on `gm_construct` with no workshop). GSLT is set (value in `SECRETS.local.md`).
- **GMOD workshop maps mount ONLY at boot, from the collection:** `wscollectionid` (`host_workshop_collection`) is read at server *start* — GMOD downloads the collection's addons to `serverfiles/garrysmod/cache/srcds/*.gma` and **mounts** them for that session. An **empty collection mounts 0 addons**, so its maps won't load even though the `.gma` files sit in the cache (cache = download cache, NOT an install). Therefore: (a) setting `defaultmap` to a workshop map with no collection set **bricks the boot** (`No such map … / Server is not running or has no active map!`); (b) live `changelevel` only reaches maps mounted at the **last** boot, so changing the collection/rotation needs a **restart**. Only `gm_construct`/`gm_flatgrass` are always present. Workshop `.bsp` names are **lowercase** even when the Workshop *title* is mixed-case (title "ttt_Clue_se" → map `ttt_clue_se`).
- **GMOD map discovery = `garrysmod/maps/` ONLY (single source of truth).** GMOD scatters downloaded workshop content across **two locations/formats** — legacy addons as `cache/srcds/<id>.gma` and modern ones as `serverfiles/steam_cache/content/4000/<id>/*.gma` — so no single cache holds every map. The connector's `syncMaps()` extracts each downloaded collection map's `.bsp` (via `serverfiles/bin/gmad_linux`; these TTT maps are self-contained packed `.bsp`) into `garrysmod/maps/`, and `installedMaps()` reads **only** that dir. So a newly-added collection map appears in the panel only after the **"Sync from Collection"** action (flow: add on Steam → Restart Hosting to download → Sync to install). Removal from the collection is **not** auto-uninstalled (additive).
- **Startup-config "Profiles" (servers panel):** named structured startup configs per server, stored in SQLite (`server_profiles` + `server_active_profile`, migration 003). A profile is what the server *boots as*; live RCON/console commands are ephemeral and never written back. Each connector implements `profileSchema`/`defaultProfileSettings`/`validateProfileSettings`/`applyProfileSettings`/`captureProfileSettings` on `BaseConnector` (generic lifecycle = list/get/create/update/delete/apply/capture + an auto-seeded "Default"). **All five games (GMOD, Prop Hunt, Factorio, CS, Minecraft) are wired for profiles.** For GMOD the rotation's **first map is the boot map** (no separate field), and the panel's **Apply = apply config + restart** so the collection actually mounts. The panel shows a **Profiles** panel (config) AND a **Quick Settings** panel (operations like Factorio Save As / Generate) together — a game can have one or both; a game wired for profiles trims its `getSettings` so config doesn't double-render.
- **Prop Hunt = VM 105, a clone of GMOD VM 104, on port 27067.** A separate LinuxGSM GMOD instance at `/home/miles/phserver` (systemd `phserver.service`) running `gamemode="prop_hunt"` (the **Prop Hunt: X2Z** Workshop gamemode). `PropHuntConnector` extends `GmodConnector` (install paths derive from `gsmDir`; `mapPrefixes=['ph_','gm_']`; RCON on the registry game port). It has its **own dedicated GSLT** (`SECRETS.local.md`) so it can run alongside TTT. **Workshop content mounts from the public Steam collection `3737190377`** (`wscollectionid` in the instance cfg) — GMOD downloads + mounts it at boot. The X2Z gamemode addon ships the `prop_hunt` (+ `base_phx`) gamemode folder, so `gamemode=prop_hunt` loads; the 7 `ph_` maps + taunt packs + loadout manager come along, and clients auto-download via the collection. `applyProfileSettings` deliberately does **NOT** write `wscollectionid` (so Apply can't break the mount). Edit X2Z config via the panel's **Raw Config** editor: `server.cfg`/`active.cfg` for `ph_`/`phx_` cvars, `lgsm.cfg` for the collection id/ports, plus X2Z's `phx-loadout`/`phx-admins` data files (chowned back to `miles` after write). NOTE: `prop_hunt` is not built into GMOD (only base/sandbox/terrortown ship), so the collection mount is required to boot PH. **`3736674438` is a working TTT *maps* collection** (separate from PH) — verified 2026-06-04 on the Docker keeper to mount 5 `ttt_` maps (ttt_clue_se, ttt_diescraper, ttt_dolls, ttt_minecraft_b5, ttt_waterworld), so the earlier note that it was "removed by Steam" was wrong. (`3737136538` was reportedly a dead PH collection; not re-checked.)
- **Offsite backups → Cloudflare R2 (`gamertown-backups`, remote `r2`) are LIVE.** On the keeper a **host systemd timer** (`gt-db-backup.timer` 04:00 → `/usr/local/bin/gt-backup.sh`) pushes the **app DB** (`app/`, keep 7) + **Factorio save** (`factorio/`, keep 3); the **MC world** (`minecraft/`, ~5.4 GB) + **age-encrypted `secrets.env`** (`secrets/`) are **on-demand**. rclone runs as host **root** (keys in `/root/.config/rclone/rclone.conf`); the repo/app never hold R2 keys. **rclone must be ≥ ~1.66 (we run 1.74.2)** — Ubuntu's stock **1.60.1 returns `501 NotImplemented` on R2 `rcat`**. Prune orders by the `_YYYYMMDD_HHMMSS` **in the name**, NOT object ModTime. The panel's MC backup holds a long `tar | rclone rcat` (~5 GB / ~2.6 min): backend 900 s + a Caddy `@backups` matcher (before `/api/*`) at 20 min. Full backup map + recovery steps → [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md).

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
secret map + recovery → [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md).
