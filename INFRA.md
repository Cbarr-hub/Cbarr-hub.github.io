# Gamertown Infrastructure

**Last updated:** 2026-05-31  
**Status:** Live

---

## Network Overview

| Layer | Host | IP | Notes |
|---|---|---|---|
| Router | AT&T BGW210-700 | 192.168.1.254 (gateway) | Home LAN gateway |
| Proxmox host | `pve` | 192.168.1.109 | Debian 13 (trixie), bare metal |
| Gamertown container | `gamertown` (CT 103) | 192.168.1.200 | Debian 12, LXC unprivileged |
| Public WAN | — | 104.177.95.216 | Dynamic — check if it changes |

---

## Proxmox Host (`pve` — 192.168.1.109)

- **OS:** Debian GNU/Linux 13 (trixie)
- **Role:** Hypervisor. Runs all VMs and containers.
- **Proxmox UI:** https://192.168.1.109:8006
- **Node binaries:** `/usr/bin/node` = v20.19.2, `/usr/local/bin/node` = v24.16.0
- **Repo clone (for git ops):** `/root/Cbarr-hub.github.io`
  - This is the working copy used for `git pull` / `git push` to GitHub.
  - The container has its own independent clone at `/srv/gamertown`.

### Virtual Machines

| VMID | Name | RAM | Disk | Status |
|---|---|---|---|---|
| 100 | Counter-Strike-Server | 6 GB | 92 GB | Stopped |
| 101 | Factorio-Server | 6 GB | 50 GB | Stopped |
| 102 | Minecraft-Server | 16 GB | 40 GB | Stopped |

Start a VM: `qm start <vmid>`  
Stop a VM: `qm stop <vmid>`

---

## Gamertown Container (CT 103 — 192.168.1.200)

- **Template:** `debian-12-standard_12.12-1_amd64.tar.zst`
- **Resources:** 1 GB RAM, 512 MB swap, 10 GB rootfs (`local-lvm`)
- **Network:** `vmbr0`, static IP `192.168.1.200/24`, gateway `192.168.1.254`
- **Node:** v20.20.2 (NodeSource `/usr/bin/node`)
- **Caddy:** v2.11.3 (`/usr/bin/caddy`)

### Enter the container

```bash
# From Proxmox host:
pct exec 103 -- bash
# or interactively:
pct enter 103
```

### Key Paths Inside Container

| Path | Purpose |
|---|---|
| `/srv/gamertown/` | Repo root — static site files served by Caddy |
| `/srv/gamertown/backend/` | Fastify backend source |
| `/srv/gamertown/backend/.env` | Runtime config (PORT, DB_PATH, SESSION_KEY_PATH, NODE_ENV) |
| `/srv/gamertown/backend/data/gamertown.sqlite` | SQLite database |
| `/srv/gamertown/backend/data/session-key` | Session encryption key (auto-generated) |
| `/etc/caddy/Caddyfile` | Reverse proxy config |
| `/var/log/caddy/gamertown.log` | Caddy access log |

### Services

```bash
# Backend (Fastify on 127.0.0.1:3000)
pct exec 103 -- systemctl status gamertown
pct exec 103 -- systemctl restart gamertown
pct exec 103 -- journalctl -u gamertown -f          # live logs

# Caddy (HTTPS on :443, HTTP on :80)
pct exec 103 -- systemctl status caddy
pct exec 103 -- systemctl reload caddy              # apply Caddyfile changes
pct exec 103 -- journalctl -u caddy -f
```

### Caddyfile (`/etc/caddy/Caddyfile`)

```caddyfile
https://192.168.1.200, https://104.177.95.216 {
    tls internal          # self-signed CA (no domain yet)

    encode gzip

    handle /backend/* {   # block source code exposure
        respond 403
    }

    handle /api/* {
        reverse_proxy 127.0.0.1:3000
    }

    handle {
        root * /srv/gamertown
        try_files {path} {path}.html /index.html
        file_server
    }

    log {
        output file /var/log/caddy/gamertown.log
        format console
    }
}
```

**TLS note:** Caddy uses its internal CA (self-signed). Browsers will warn on first visit — accept once and it persists. When a real domain is pointed at the server, replace `tls internal` with nothing and Caddy will auto-obtain a Let's Encrypt cert.

---

## Port Forwarding (AT&T BGW210-700)

Configured via Firewall → NAT/Gaming at http://192.168.1.254

| Service | External Port | Internal Target | Protocol |
|---|---|---|---|
| HTTPS (Gamertown) | 443 | 192.168.1.200 | TCP/UDP |
| Counter Strike | 1200, 6003, 7001-7002, 27000-27039 | counter-strike-ubuntu | TCP/UDP |
| Factorio | 34197 | factorio-ubuntu | TCP/UDP |
| Minecraft | 25565 | minecraft-server | TCP/UDP |
| SSH | 22 | DESKTOP-CEDMDNJ | TCP |

**Note:** Port 80 cannot be forwarded on this router model — the BGW210 reserves it internally.

---

## Deployment: Updating the Site

### Pull latest code into the container

```bash
pct exec 103 -- bash -c "git config --global --add safe.directory /srv/gamertown && cd /srv/gamertown && git pull"
pct exec 103 -- systemctl restart gamertown   # only if backend changed
pct exec 103 -- systemctl reload caddy        # only if Caddyfile changed
```

> **Note:** The `safe.directory` line is required when running as root via `pct exec` because the repo is owned by the `gamertown` service user. The config flag is idempotent — safe to run every time.

### Two independent git clones

The Proxmox host (`/root/Cbarr-hub.github.io`) and the container (`/srv/gamertown`) are **separate clones**. A `git push` from the host does not update the container — you must `git pull` inside the container separately.

### Backend dependency update

```bash
pct exec 103 -- bash -c "cd /srv/gamertown/backend && su -s /bin/bash gamertown -c 'npm install --omit=dev'"
pct exec 103 -- systemctl restart gamertown
```

---

## Database Operations

```bash
# Run migrations (idempotent)
pct exec 103 -- bash -c "cd /srv/gamertown/backend && su -s /bin/bash gamertown -c 'npm run migrate'"

# Seed initial users + games (INSERT OR IGNORE — safe to re-run)
pct exec 103 -- bash -c "cd /srv/gamertown/backend && su -s /bin/bash gamertown -c 'npm run seed'"

# User management via CLI
pct exec 103 -- bash -c "cd /srv/gamertown/backend && node src/cli.js list-users"
pct exec 103 -- bash -c "cd /srv/gamertown/backend && node src/cli.js create-admin"
pct exec 103 -- bash -c "cd /srv/gamertown/backend && node src/cli.js delete-user"

# Direct SQLite access
pct exec 103 -- bash -c "sqlite3 /srv/gamertown/backend/data/gamertown.sqlite"
```

**Seed users:** Wiley, Miles, Jack, Gabe, Austin, Connor, Patrick (all `is_admin=1`).  
Default seed passwords are defined in `backend/src/seed.js` — change them via CLI after first deploy.

---

## Health Checks

```bash
# From Proxmox host:
curl -sk https://192.168.1.200/api/health    # LAN
curl -sk https://104.177.95.216/api/health   # WAN (public)

# Full login flow test
CSRF=$(curl -sk https://192.168.1.200/api/csrf -c /tmp/c.txt | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -sk -X POST https://192.168.1.200/api/auth/login \
  -H "Content-Type: application/json" -H "x-csrf-token: $CSRF" \
  -b /tmp/c.txt -c /tmp/c.txt \
  -d '{"username":"Wiley","password":"<password>"}'
curl -sk https://192.168.1.200/api/me -b /tmp/c.txt
```

---

## Game Server Control Panel (`/servers.html` + `/api/servers`)

Admins can power-cycle, update, and edit the config of the three game VMs from the
browser at `https://192.168.1.200/servers.html`. The Fastify backend (in CT 103)
reaches the VMs through the **Proxmox VE API** with a scoped **API token** — it
never runs `qm` and never needs root on the host.

### Architecture (layers, infra → UI)

```
servers.html → db.js → /api/servers routes → service → connector → ProxmoxClient → PVE API
```

| Layer | File | Responsibility |
|---|---|---|
| Transport | `backend/src/proxmox/client.js` | Raw PVE HTTP + token auth only |
| Registry | `backend/src/servers/registry.js` | id → VMID (CS 100, Factorio 101, Minecraft 102) |
| Connectors | `backend/src/servers/connectors/*` | Per-game config paths + update recipes |
| Service | `backend/src/servers/service.js` | Validate id/action, dispatch, normalize |
| Routes | `backend/src/routes/servers.js` | `requireAdmin` + CSRF, error→HTTP mapping |

VMIDs only ever come from the registry — the API can never be aimed at another VM.

### API endpoints (all admin-only)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/servers` | list + live status/uptime |
| GET | `/api/servers/:id` | one server's status |
| POST | `/api/servers/:id/actions/:action` | action ∈ `start,shutdown,reboot,stop` |
| GET | `/api/servers/:id/config` | list whitelisted config files |
| GET | `/api/servers/:id/config/:file` | read a config file |
| PUT | `/api/servers/:id/config/:file` | write a config file |
| POST | `/api/servers/:id/update` | run the game's update recipe |

`shutdown`/`reboot` are graceful (ACPI, needs guest agent); `stop` is a hard
power-off (force, confirm-gated in the UI). If the PVE token is unset, every
endpoint returns **503 "not configured"** — the backend still boots.

### One-time Proxmox setup

1. **Create an API token** — Proxmox UI → Datacenter → Permissions → API Tokens →
   Add. Suggested id `gamertown@pve!serverctl`. Copy the secret (shown once).
2. **Role + ACL** — Datacenter → Permissions → Roles → create e.g. `ServerCtl`
   with privileges:
   - Power + status: `VM.Audit`, `VM.PowerMgmt`
   - In-VM update/config (guest agent): `VM.GuestAgent.Audit`,
     `VM.GuestAgent.FileSystemRead`, `VM.GuestAgent.FileSystemWrite`, `VM.Monitor`
     (names vary by PVE version; on older 7.x use `VM.Monitor` alone).

   Then Permissions → Add → API Token Permission: path `/vms/100` (repeat 101, 102,
   or use a pool), the token, role `ServerCtl`. If the token has *Privilege
   Separation* enabled, the token itself must be granted the role (not just the user).
3. **Guest agent in each VM** (needed for update + config editing, not basic power):
   ```bash
   # inside each game VM:
   apt install -y qemu-guest-agent && systemctl enable --now qemu-guest-agent
   # then on the Proxmox host:
   qm set 100 --agent enabled=1   # repeat for 101, 102
   # reboot the VM once so the agent channel attaches
   ```
4. **Backend config** — add to `/srv/gamertown/backend/.env` (see `.env.example`):
   ```
   PVE_API_URL=https://192.168.1.109:8006
   PVE_NODE=pve
   PVE_TOKEN_ID=gamertown@pve!serverctl
   PVE_TOKEN_SECRET=<the secret from step 1>
   PVE_TLS_REJECT_UNAUTHORIZED=false   # PVE self-signed cert
   ```
   Then `npm install --omit=dev` (adds `undici`) and
   `systemctl restart gamertown`.

### Per-game paths to verify

The update recipes and config whitelists in `backend/src/servers/connectors/`
(`factorio.js`, `minecraft.js`, `counterstrike.js`) use **assumed** in-VM paths
and systemd unit names (e.g. Factorio `/opt/factorio/data/server-settings.json`,
Minecraft `/srv/minecraft/server.properties`, CS `/home/steam/cs/...`). These are
the only game-specific knowledge in the system — adjust the constants at the top
of each connector to match the real layout inside each VM.

### Smoke test

```bash
# unconfigured / wrong-role → clear errors, backend stays up
curl -sk https://192.168.1.200/api/servers          # 401 (not signed in)
# signed-in admin (reuse the cookie jar from the login flow above):
curl -sk https://192.168.1.200/api/servers -b /tmp/c.txt          # list + status
curl -sk -X POST https://192.168.1.200/api/servers/factorio/actions/start \
  -H "x-csrf-token: $CSRF" -b /tmp/c.txt -c /tmp/c.txt            # start Factorio
```

---

## Future: Adding a Domain + Real TLS

1. Buy a domain (e.g. `gamertown.online`) and point DNS A record at `104.177.95.216`
2. Edit `/etc/caddy/Caddyfile` inside CT 103:
   - Replace `https://192.168.1.200, https://104.177.95.216` with `yourdomain.com`
   - Remove `tls internal` (Caddy auto-obtains Let's Encrypt cert)
3. Reload: `pct exec 103 -- systemctl reload caddy`
4. **Port 80 problem:** Let's Encrypt HTTP-01 challenge requires port 80. Since BGW210 blocks port 80 forwarding, use DNS-01 challenge via Cloudflare API instead (no port 80 needed).

---

## SSH / GitHub Access

- SSH public key: `/root/.ssh/id_rsa.pub` on Proxmox host — added to GitHub account for repo push access.
- The container clones via HTTPS (public repo) and has no SSH key.
- To push from the Proxmox host, the SSH key must remain in GitHub → Settings → SSH keys.
