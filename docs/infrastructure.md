# Gamertown Infrastructure

**Last updated:** 2026-06-05  
**Status:** Live — **migrated to a single Docker host ("the keeper").**

> **Disaster recovery → [`disaster-recovery.md`](disaster-recovery.md)** — rebuild from GitHub + R2 + the age passphrase.

---

## Current architecture (Docker on keeper VM 106)

As of **2026-06-04** all of Gamertown — website, app, and the five game servers — runs
as one **`docker compose` stack** on a single host, the "keeper":

| Thing | Value |
|---|---|
| Keeper | Proxmox **VM 106** `gamertown-docker` — 192.168.1.241, MAC `bc:24:11:62:f5:5d` (8 cores / 20 GB / 160 GB) |
| Role | Docker host. The PVE box `pve` (192.168.1.109) is **only** the hypervisor — no Docker on it. |
| Enter | `ssh root@192.168.1.241` (passwordless from `pve`) · `qm guest exec 106 -- …` |
| Repo / stack | `/root/gamertown` (branch `main`); compose project `gamertown` = `docker-compose.yml` + `servers.compose.yml` + project `.env` |
| Containers (8) | `gamertown-app-1` (Fastify), `gamertown-caddy-1` (Caddy :443), `gamertown-docker-proxy-1` (read-only Docker API → dashboard), `minecraft`, `gmod`, `prophunt`, `counterstrike`, `factorio` — all `restart: unless-stopped` |
| State (volumes) | `gamertown_gt-data` (app DB + session-key), `_mc-data`, `_factorio-data`, `_gmod-data`, `_ph-data`, `_cs2-data`, `_caddy_data`, `_caddy_config` |
| Edge | `gamertown.solutions` via **Cloudflare** → BGW210 `:443` forward → keeper. Caddy terminates TLS with a **Cloudflare Origin cert** (`/etc/gamertown/certs/`) + gates the site with `forward_auth` → `/api/auth/gate`. No tunnel. |
| Secrets | `/etc/gamertown/secrets.env` (app/Caddy) + `/root/gamertown/.env` (game interpolation) — neither in git. → DR doc |
| Backups | **weekly** host timer `gt-db-backup.timer` (Mon 04:00) → `/usr/local/bin/gt-backup.sh` (app DB + Factorio save + Minecraft world → R2); age-encrypted secret bundle (`secrets.tar.age`) on-demand. Host-driven (the app/containers hold no R2 keys). → DR doc |
| Session tracking | host **service** `gt-session-tracker.service` → `tools/gt-session-tracker.mjs` (long-running, independent of the app). Tails `docker logs` for Minecraft/Factorio + RCON-polls the Source games, writing player join/leave rows into the app DB (`players` + `server_sessions`, FK to `games` where `hosted=1`). The app only *reads* them, for the servers panel's standalone **Events** section. Needs `node` + `sqlite3` **≥ 3.38** on the host (for `unixepoch()` + `-json`; probed at startup, fail-fast). **CS2 `status` is name-only** (redacted SteamID), so those rows don't seed the global `players` roster. |

**Per-game backend flag.** Each registry entry carries `backend: 'docker'` + a `container`
locator; the `DockerClient` duck-types the small transport surface the connectors consume,
so they're reused almost unchanged. RCON is spoken **over TCP**
(`backend/src/servers/rcon-tcp.js`), not via an in-guest agent.

**Deploy:** on the keeper, `git pull` in `/root/gamertown`, then
`docker compose -f docker-compose.yml -f servers.compose.yml up -d --build`.
*(The keeper checkout may need a one-time `git checkout -f main` to reconcile post-migration — see the DR doc §6.)*

**Forwarded ports** (BGW210 → keeper MAC, so they follow it across DHCP): **443**
(HTTPS), **25565** (Minecraft), **27066** (GMOD/TTT), **27067** (Prop Hunt),
**27000–27039** (CS), **34197** (Factorio).

---

## Legacy reference (pre-Docker topology)

The previous **Proxmox topology** — CT 103 (web-app container) + per-game VMs
(100/101/102/104/105), `pct`/`qm`, the PVE API token, in-guest paths — was retired at the
2026-06-04 cutover and removed from the tree. The current per-game config specifics (CS /
Factorio / GMOD cvars + save layouts) all live in **[`../CLAUDE.md`](../CLAUDE.md) § Known
gotchas**, which is the live source of truth. If you need the old BGW210 port-forward
scripting or VM-era details, recover `INFRA_LEGACY.md` from git history (commits before
2026-06-05).

## See also

- **[`../CLAUDE.md`](../CLAUDE.md) § Critical infra facts** — canonical quick-reference for the
  keeper / repo / stack / DB / secrets (this doc intentionally doesn't repeat that table).
- **[`disaster-recovery.md`](disaster-recovery.md)** — R2 backup inventory + full rebuild.
- **[`backend.md`](backend.md)** — the backend API + game-server control panel.
