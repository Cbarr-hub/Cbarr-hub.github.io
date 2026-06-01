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
- **GMOD workshop maps need a GSLT + CS:S mount:** set a GSLT token (appid 4000) in the instance cfg for `wscollectionid` downloads to work reliably; CS:S content lives at `serverfiles/css-content` mounted via `garrysmod/cfg/mount.cfg` so TTT maps aren't missing textures. `terrortown` itself is built into GMOD (boots on `gm_construct` with no workshop).

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
