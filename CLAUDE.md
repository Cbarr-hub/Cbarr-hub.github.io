# Gamertown — Claude Code Context

## Project

Gamertown is a live web app for a friend group: forum, gambling/games, game server control panel.
Stack: **Fastify + SQLite + Caddy**, deployed on **Proxmox LXC CT 103** (192.168.1.200).

Full infra details → [`INFRA.md`](INFRA.md)  
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
    proxmox/            PVE API client
    cli.js              user management CLI
  data/                 SQLite DB + session key (gitignored)
  .env                  runtime config (gitignored)
tests/                  test suite
```

---

## Critical infra facts

| Thing | Value |
|---|---|
| Container entry | `pct exec 103 -- bash` (from Proxmox host `pve` at 192.168.1.109) |
| Site root in container | `/srv/gamertown` |
| Backend | Fastify on `127.0.0.1:3000`, systemd unit `gamertown` |
| Reverse proxy | Caddy 2.11.3, config at `/etc/caddy/Caddyfile` |
| Database | `/srv/gamertown/backend/data/gamertown.sqlite` |
| Public IP | `104.177.95.216` (AT&T dynamic — may change) |

**Two-clone setup:** `/root/Cbarr-hub.github.io` (host, for git ops) and `/srv/gamertown` (container, what Caddy serves). A `git push` from the host does **not** update the container — run `git pull` inside CT 103 separately.

---

## Common operations

```bash
# Deploy code update
pct exec 103 -- bash -c "git config --global --add safe.directory /srv/gamertown && cd /srv/gamertown && git pull"
pct exec 103 -- systemctl restart gamertown   # if backend changed
pct exec 103 -- systemctl reload caddy        # if Caddyfile changed

# Tail logs
pct exec 103 -- journalctl -u gamertown -f
pct exec 103 -- journalctl -u caddy -f

# Health check
curl -sk https://192.168.1.200/api/health

# Database
pct exec 103 -- bash -c "cd /srv/gamertown/backend && su -s /bin/bash gamertown -c 'npm run migrate'"
pct exec 103 -- bash -c "sqlite3 /srv/gamertown/backend/data/gamertown.sqlite"

# User management
pct exec 103 -- bash -c "cd /srv/gamertown/backend && node src/cli.js list-users"
```

---

## Known gotchas

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
- **Prop Hunt = VM 105, a clone of GMOD VM 104, on port 27067.** A separate LinuxGSM GMOD instance at `/home/miles/phserver` (systemd `phserver.service`) running `gamemode="prop_hunt"` (the **Prop Hunt: X2Z** Workshop gamemode). `PropHuntConnector` extends `GmodConnector` (install paths derive from `gsmDir`; `mapPrefixes=['ph_','gm_']`; RCON on the registry game port). It has its **own dedicated GSLT** (`SECRETS.local.md`) so it can run alongside TTT. **Workshop content installs by item id, NOT a collection** — all of dheagman's Steam collections were removed, so `wscollectionid` stays empty and the panel's **Sync** (connector `syncMaps`) runs `steamcmd +workshop_download_item 4000 <id>` for the profile's `workshopItems`, extracting maps→`garrysmod/maps/` and the gamemode→`garrysmod/gamemodes/`, and writes a `resource.AddWorkshop` autorun for clients. `prop_hunt` is **not** built into GMOD (only base/sandbox/terrortown ship), so the X2Z gamemode must be installed (set the profile's Workshop Item IDs → Sync) before the server can boot PH.

---

## Environment (.env keys)

```
PORT=3000
HOST=127.0.0.1
DB_PATH=./data/gamertown.sqlite
SESSION_KEY_PATH=./data/session-key
NODE_ENV=production
PVE_API_URL=https://192.168.1.109:8006
PVE_NODE=pve
PVE_TOKEN_ID=gamertown@pve!serverctl
PVE_TOKEN_SECRET=<secret>
PVE_TLS_REJECT_UNAUTHORIZED=false
PUBLIC_HOST=104.177.95.216
```
