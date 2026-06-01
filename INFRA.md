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
| 104 | Garrys-Mod-Server | 6 GB | 40 GB | Running |

> CT 103 is the Gamertown web app (LXC), so the GMOD game VM is 104.
> VM 104 was built from the Ubuntu 24.04 cloud image + cloud-init (login user
> `miles`), unlike 100–102 which were manual ISO installs.

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
| Garry's Mod (TTT) | 27066 | Garrys-Mod-Server (192.168.1.243) | TCP/UDP |
| SSH | 22 | DESKTOP-CEDMDNJ | TCP |

> **GMOD port note:** GMOD uses **27066** specifically because the Counter-Strike
> forward already claims the whole 27000–27039 range (pointed at the CS VM), so
> the obvious 27015/27016 are taken. The 27066 forward is **live** (custom service
> `GmodTTT`, TCP/UDP, → `Garrys-Mod-Server` / 192.168.1.243) and verified — an A2S
> query to `104.177.95.216:27066` returns the "Gamertown TTT" server. See
> "Scripting the BGW210 port-forward" below for how it was added.

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
| GET / PUT | `/api/servers/:id/settings` | structured quick settings (read / apply) |
| GET / POST | `/api/servers/:id/maps` | CS workshop-map catalog (list / add) |
| PATCH / DELETE | `/api/servers/:id/maps/:workshopId` | rename / remove a catalog map |
| GET / POST | `/api/servers/:id/configs` | CS saved-config library (list / create) |
| GET / PUT / DELETE | `/api/servers/:id/configs/:configId` | read / update / delete a saved config |
| GET | `/api/servers/:id/live` | live-control availability + curated actions |
| POST | `/api/servers/:id/live/command` | run a free-form console/RCON command |
| POST | `/api/servers/:id/live/action` | run a curated action (restart round, cheats, …) |
| GET / POST | `/api/servers/:id/backups` | list / create offsite backups (Factorio + Minecraft) |
| POST | `/api/servers/:id/backups/:name/restore` | restore a backup |
| DELETE | `/api/servers/:id/backups/:name` | delete a backup from R2 |

`shutdown`/`reboot` are graceful (ACPI, needs guest agent); `stop` is a hard
power-off (force, confirm-gated in the UI). If the PVE token is unset, every
endpoint returns **503 "not configured"** — the backend still boots.

### Proxmox setup (as built — already done)

Reproduced here for reference / rebuild. All commands run on the `pve` host.

1. **Role** `ServerCtl` with exactly these privileges (PVE 9 names):
   ```bash
   pveum role add ServerCtl --privs "VM.Audit,VM.PowerMgmt,\
   VM.GuestAgent.Audit,VM.GuestAgent.FileRead,VM.GuestAgent.FileWrite,VM.GuestAgent.Unrestricted"
   ```
   `VM.GuestAgent.Unrestricted` is what permits `agent exec` (updates);
   `FileRead`/`FileWrite` permit config editing; `VM.Audit`/`VM.PowerMgmt` cover
   status + power.
2. **Token-only user + token** (privilege separation on):
   ```bash
   pveum user add gamertown@pve --comment "Gamertown game-server control (token only)"
   pveum user token add gamertown@pve serverctl --privsep 1   # prints the secret ONCE
   ```
3. **ACLs — grant on VMs 100/101/102/104 only.** ⚠️ With privsep on, a token's
   effective rights are the **intersection of the token's ACLs and the owning
   user's ACLs**, so BOTH must be granted:
   ```bash
   for v in 100 101 102 104; do
     pveum acl modify /vms/$v --users  'gamertown@pve'            --roles ServerCtl
     pveum acl modify /vms/$v --tokens 'gamertown@pve!serverctl'  --roles ServerCtl
   done
   ```
4. **Node-level read access for the host dashboard.** The servers page shows a
   Proxmox host dashboard (CPU/RAM/load/uptime) backed by `GET /api/servers/node`
   → PVE `GET /nodes/pve/status`, which requires **`Sys.Audit` on `/nodes/pve`**.
   `ServerCtl` is intentionally VM-scoped and has no node rights, so this is a
   separate minimal read-only role granted on the node path. Same privsep rule:
   grant to BOTH the user and the token. `propagate 0` keeps it on `/nodes/pve`
   itself (the status check is against that path) and prevents it cascading audit
   rights onto every guest under the node.
   ```bash
   pveum role add NodeAudit --privs "Sys.Audit"
   pveum acl modify /nodes/pve --users  'gamertown@pve'           --roles NodeAudit --propagate 0
   pveum acl modify /nodes/pve --tokens 'gamertown@pve!serverctl' --roles NodeAudit --propagate 0
   ```
   Without this the dashboard shows *"host stats unavailable: upstream Proxmox
   error"* (PVE returns `403 Permission check failed (/nodes/pve, Sys.Audit)`),
   while the per-VM cards keep working — they only touch `/vms/*`.
5. **Guest-agent channel** on each VM (host side): `qm set 100 --agent enabled=1`
   (repeat 101, 102, 104). Takes effect on the VM's next boot.
6. **Backend config** — `/srv/gamertown/backend/.env` (see `.env.example`):
   ```
   PVE_API_URL=https://192.168.1.109:8006
   PVE_NODE=pve
   PVE_TOKEN_ID=gamertown@pve!serverctl
   PVE_TOKEN_SECRET=<the secret from step 2>
   PVE_TLS_REJECT_UNAUTHORIZED=false   # PVE self-signed cert
   ```
   Then `npm install --omit=dev` (adds `undici`) + `systemctl restart gamertown`.

Verify a token end-to-end: `qm agent 101 ping` (guest side) and
`curl -sk -H "Authorization: PVEAPIToken=gamertown@pve!serverctl=<secret>" \
https://192.168.1.109:8006/api2/json/nodes/pve/qemu/101/status/current`.

### Game Server VMs — in-guest layout (verified)

All guests are **Ubuntu 24.04**, login user **`miles`**, on the LAN via DHCP.
`qemu-guest-agent` is installed + active in all of them. The connector constants in
`backend/src/servers/connectors/*` match these paths.

| VM | Host / IP | Mgmt | Install dir | Control (run as `miles`) | Editable config files |
|---|---|---|---|---|---|
| 100 CS2 | `counter-strike-ubuntu` / .75 | LinuxGSM `cs2server` | `/home/miles/csserver` | `./cs2server start\|stop\|restart\|update` | `serverfiles/game/csgo/cfg/cs2server.cfg`, `lgsm/config-lgsm/cs2server/{cs2server,common}.cfg` |
| 101 Factorio | `factorio-ubuntu` / .74 | LinuxGSM `fctrserver` | `/home/miles/fctrserver` | `./fctrserver start\|stop\|restart\|update` | `serverfiles/data/server-settings.json`, `lgsm/config-lgsm/fctrserver/{fctrserver,common}.cfg` |
| 102 Minecraft | `minecraft-server` / .68 | plain + tmux | `/home/miles/MinecraftServer` | `tmux` session `minecraft` + `./start.sh` | `server.properties`, `whitelist.json`, `ops.json`, `banned-{players,ips}.json` |
| 104 GMOD/TTT | `Garrys-Mod-Server` / .243 | LinuxGSM `gmodserver` | `/home/miles/gmodserver` | `./gmodserver start\|stop\|restart\|update` | **game cfg** `serverfiles/garrysmod/cfg/gmodserver.cfg` (TTT cvars + `rcon_password`), `serverfiles/garrysmod/mapcycle.txt`, `lgsm/config-lgsm/gmodserver/{gmodserver,common}.cfg` |

(IPs are DHCP — `.68/.74/.75/.243` at time of writing; match by MAC if they change:
CS `BC:24:11:4B:15:79`, Factorio `BC:24:11:40:DF:F9`, Minecraft `BC:24:11:DD:8D:81`,
GMOD `BC:24:11:C9:B7:F6`.)

> **GMOD specifics (VM 104):** runs the built-in `terrortown` (TTT) gamemode.
> The Source game config is `cfg/gmodserver.cfg` (launched via
> `+servercfgfile gmodserver.cfg`) — **not** a `server.cfg`; don't confuse it with
> the identically-named LinuxGSM *instance* cfg. Map rotation: list maps in
> `garrysmod/mapcycle.txt` with `ttt_always_use_mapcycle 1`. Workshop maps/addons
> auto-download from the `wscollectionid` in the instance cfg (needs a **GSLT**
> token in the instance cfg for reliable downloads — generate at
> steamgameservers.com, appid 4000). CS:S content is installed at
> `serverfiles/css-content` and mounted via `garrysmod/cfg/mount.cfg` so TTT maps
> have their textures.

**SSH access (live, in-guest work):** log in as `miles` on any guest, e.g.
`ssh miles@192.168.1.75` (CS2); same `miles` account on .74 (Factorio) and .68
(Minecraft). The password is **deliberately not in this file** — this is a
public `*.github.io` repo, so credentials must never be committed. It lives in
the gitignored `SECRETS.local.md` at the repo root. Prefer setting up a key
(`ssh-copy-id miles@<ip>`) and disabling password auth.

**Auto-start on boot (systemd):** each game now has a systemd unit (enabled), so
booting the VM brings the game up — the panel's VM power buttons effectively
control the game.

| VM | Unit | Type | Notes |
|---|---|---|---|
| 100 | `cs2server.service` | oneshot + `RemainAfterExit` | `ExecStart=/bin/bash -lc '… cs2server start'` — the **login shell is required** so CS2's Steam runtime env loads; `KillMode=process` so the detached game survives the start script exiting |
| 101 | `fctrserver.service` | oneshot + `RemainAfterExit` | LinuxGSM `fctrserver start/stop`; `KillMode=process` |
| 102 | `minecraft.service` | simple | runs `start.sh` (java) directly as the main process; SIGTERM = graceful save |
| 104 | `gmodserver.service` | oneshot + `RemainAfterExit` | `ExecStart=/bin/bash -lc '… gmodserver start'` (login shell for the Steam runtime); `KillMode=process` — mirrors the CS2 unit |

Manage them as root in-guest: `systemctl {start,stop,status} <unit>`. Disable
auto-start with `systemctl disable <unit>`.

### Runbook — provisioning a new game-server VM (worked example: GMOD/TTT, VM 104)

End-to-end recipe for adding a new LinuxGSM game VM, run from the **Proxmox host
`pve`** (which has `pct`/`qm`). VM 104 (Garry's Mod / TTT) was built this way.
Unlike 100–102 (manual ISO installs), this uses an **Ubuntu cloud image +
cloud-init** so the whole thing is scriptable.

**1. Create + boot the VM from the Ubuntu cloud image** (≈10 min incl. download):
```bash
cd /var/lib/vz/template
wget -O noble.img https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
qm create 104 --name Garrys-Mod-Server --memory 6144 --cores 4 --cpu host \
  --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-single --ostype l26 \
  --agent enabled=1 --machine q35 --numa 0 --sockets 1
qm importdisk 104 noble.img local-lvm
qm set 104 --scsi0 local-lvm:vm-104-disk-0,cache=writeback,discard=on,iothread=1,ssd=1
qm set 104 --boot order=scsi0 && qm resize 104 scsi0 40G
qm set 104 --ide2 local-lvm:cloudinit \
  --ciuser miles --sshkeys /root/.ssh/id_rsa.pub --ipconfig0 ip=dhcp
qm start 104
```
> The cloud image does **not** ship `qemu-guest-agent`, so `qm agent 104 ping`
> fails at first. Find the DHCP IP without the agent via the link-local address:
> `ip neigh show dev vmbr0 | grep <vm-mac>` gives the `fe80::…` address; then
> `ssh miles@fe80::…%vmbr0` works with the injected key. (VM 104 landed on
> `192.168.1.243`.)

**2. Base packages (over SSH as `miles`; 32-bit libs are required for srcds):**
```bash
sudo dpkg --add-architecture i386 && sudo apt-get update
sudo apt-get install -y qemu-guest-agent lib32gcc-s1 lib32stdc++6 \
  libsdl2-2.0-0:i386 tmux python3 curl wget file
sudo systemctl enable --now qemu-guest-agent   # now `qm agent 104 ping` works
```

**3. Install LinuxGSM into a game subdir** (matches the csserver/fctrserver layout):
```bash
# run from $HOME, then relocate so everything lives under ~/gmodserver/
wget -O linuxgsm.sh https://linuxgsm.sh && chmod +x linuxgsm.sh
./linuxgsm.sh gmodserver && ./gmodserver auto-install      # ~6 GB via SteamCMD
mkdir gmod_install && mv gmodserver lgsm serverfiles log linuxgsm.sh gmod_install/
mv gmod_install gmodserver                                  # → ~/gmodserver/{gmodserver,serverfiles,lgsm,…}
```
> LinuxGSM computes its paths from the script location, so the `mv` relocation is
> safe. Verify with `cd ~/gmodserver && ./gmodserver details`.

**4. CS:S content mount** (TTT maps need CS:S textures):
```bash
~/.local/share/Steam/steamcmd/steamcmd.sh +force_install_dir ~/gmodserver/serverfiles/css-content \
  +login anonymous +app_update 232330 validate +quit
cat > ~/gmodserver/serverfiles/garrysmod/cfg/mount.cfg <<'EOF'
"mountcfg"
{
	"cstrike"	"/home/miles/gmodserver/serverfiles/css-content/cstrike"
}
EOF
```

**5. Configure TTT + systemd unit.** Append overrides to the LinuxGSM instance
cfg `lgsm/config-lgsm/gmodserver/gmodserver.cfg`:
```
gamemode="terrortown"   defaultmap="gm_construct"   maxplayers="24"
port="27066"            clientport="27006"          sourcetvport="27021"
wscollectionid=""       gslt=""
```
Append the TTT cvars to the **game** cfg `serverfiles/garrysmod/cfg/gmodserver.cfg`
(`ttt_round_limit`, `ttt_time_limit_minutes`, `ttt_always_use_mapcycle 1`,
`ttt_traitor_pct`/`_max`, `ttt_detective_pct`/`_max`, `ttt_minimum_players`;
`rcon_password` is pre-seeded by LinuxGSM). Seed `serverfiles/garrysmod/mapcycle.txt`
with one map per line. Then create `/etc/systemd/system/gmodserver.service`
(mirror the CS2 unit: `Type=oneshot`, `RemainAfterExit=yes`, `User=miles`,
`ExecStart=/bin/bash -lc '/home/miles/gmodserver/gmodserver start'`,
`KillMode=process`), `systemctl daemon-reload && systemctl enable --now gmodserver`.
Confirm it binds: `ss -uln | grep 27066`.

**6. PVE token ACL** (so the panel's scoped token can reach VM 104) — see the
`for v in … 104` loop above. Verify the exact backend path works end-to-end:
```bash
# token-auth status + guest-agent file-read (getSettings/getLive rely on file-read)
curl -sk -H "Authorization: PVEAPIToken=gamertown@pve!serverctl=<secret>" \
  https://192.168.1.109:8006/api2/json/nodes/pve/qemu/104/status/current
```

**7. Register in the app:** add the registry row (`backend/src/servers/registry.js`)
+ the connector (`connectors/gmod.js`, `connectors/index.js`), then deploy
(`git pull` inside CT 103 + `systemctl restart gamertown`).

**8. Port-forward on the BGW210.** In the browser: http://192.168.1.254 →
**Firewall → NAT/Gaming** → enter the device access code (sticker on the gateway)
→ **Custom Services**: Service Name `GmodTTT`, Global Port Range `27066`, Base
Host Port `27066`, Protocol **TCP/UDP**, **Add** → then under **Needed by Device**
pick `Garrys-Mod-Server` (192.168.1.243) and **Add**. GMOD uses **27066** because
CS already owns the 27000–27039 range. (Done — see scripting note below.)

**9. GSLT (manual — needs a Steam login).** For reliable Workshop downloads + a
public server listing, generate a Game Server Login Token at
`steamgameservers.com` for **appid 4000** and set `gslt="<token>"` in the instance
cfg, then restart. The server runs without one (LAN / `terrortown` is built in),
just without Workshop auto-download.

### Scripting the BGW210 port-forward (no browser needed)

The gateway UI looks unscriptable (the page is JS-rendered and the access code is
hashed client-side), but the actual protocol is simple once mapped. **Use a real
browser User-Agent** (it gates non-browser UAs) and keep one `SessionID` cookie
across the flow. The access code is **`md5(accesscode + nonce)`** (plain MD5, not
HMAC), where the nonce is per-session. Endpoints:

| Step | Request |
|---|---|
| Establish session | `GET /cgi-bin/apphosting.ha` → grab `SessionID` from `Set-Cookie` (it's a `Discard` cookie, so pass it manually with `-b`, curl won't persist it) |
| Get the nonce | `GET /cgi-bin/apphosting.ha` **with** the SessionID → the body now has `<input name="nonce" value="…">` |
| Log in | `POST /cgi-bin/login.ha` with `nonce`, `password=****…` (one `*` per access-code char), `hashpassword=md5(code+nonce)`, `Continue=Continue` → 302 to apphosting.ha = success |
| Create a custom service | `POST /cgi-bin/services.ha` with fresh `nonce`, `Service=<name>`, `extMinPort`, `extMaxPort`, `intStartPort`, `protocol=both\|tcp\|udp`, `Add=Add` |
| Assign to a device | `POST /cgi-bin/apphosting.ha` with fresh `nonce`, `service=*<name>` (custom services are prefixed `*`), `device=<MAC>`, `Add=Add` |

Re-fetch the page for a **fresh nonce before every POST**. Devices are selected by
**MAC** (the GMOD VM is `bc:24:11:c9:b7:f6`). Verify end-to-end with an A2S query:
`echo -en '\xff\xff\xff\xffTSource Engine Query\x00' | nc -u -w2 104.177.95.216 27066`
should return the server name. This is exactly how the `GmodTTT` (27066) forward
was added.

### Offsite backups (rclone → R2)

The panel's **Backups** card (Factorio + Minecraft) pushes point-in-time archives
off the game VM to a **Cloudflare R2** bucket via `rclone`, so they survive a VM or
disk loss. This is distinct from "Save As", which makes a *loadable* save on the VM
itself. The backend only invokes `rclone` (as `miles`, through the guest agent) —
**it never holds the R2 credentials**; rclone reads them from its own on-VM config,
the same posture as RCON passwords. Counter-Strike has no backups (404).

- **Bucket layout:** one bucket `gamertown-backups`, rclone remote named `r2`,
  per-game prefix — `factorio/<save>_<ts>.zip`, `minecraft/<world>_<ts>.tar.gz`
  (`<ts>` = UTC `YYYYMMDD_HHMMSS`). Factorio uploads the active save zip; Minecraft
  streams a `tar.gz` of the active world dir (`tar … | rclone rcat`).
- **Restore:** Factorio downloads the zip into `serverfiles/saves/` as a loadable
  save (then "Load Existing World" — no restart). Minecraft is destructive, so it
  stops the service → swaps the world dir in place → restarts.

**One-time setup (per game VM, 101 + 102) — required before the panel works:**

1. In the Cloudflare dashboard: create R2 bucket `gamertown-backups` and an R2 API
   token (Access Key ID + Secret) scoped to it; note the account endpoint
   `https://<accountid>.r2.cloudflarestorage.com`.
2. On the VM as `miles`: install rclone (`sudo apt install rclone` or the official
   script) and `rclone config` a remote named **`r2`** — type `s3`, provider
   `Cloudflare`, with that endpoint + keys. Config lands at
   `/home/miles/.config/rclone/rclone.conf`. **Keep the keys out of this repo** —
   note them in the gitignored `SECRETS.local.md` if anywhere.
3. Verify: `runuser -u miles -- rclone lsd r2:gamertown-backups` lists the bucket.

Until this is done, the backend degrades gracefully: `GET /api/servers/:id/backups`
returns `{ available:false, reason:"rclone/R2 not configured on this VM" }` and the
panel shows that message instead of erroring.

**CS quick settings (map / workshop map / game mode / name / max players):**
`servers.html` shows a structured editor backed by
`GET/PUT /api/servers/counterstrike/settings`. The cs2 process launches with only
`+exec cs2server.cfg`, so the real control surface is the **game config**
`serverfiles/game/csgo/cfg/cs2server.cfg`:
- `map "<stock>"` — stock map
- `host_workshop_map "<id>"` — **Steam Workshop map; OVERRIDES `map`** (this is why
  the server can run e.g. Assembly `3071005299` while `map` says `de_anubis`)
- `game_alias "<alias>"` — game mode (competitive / casual / deathmatch / wingman)
- `hostname "<name>"` — server display name (shown in CS2 server browser)

`maxplayers` lives in the LGSM instance cfg (`-maxplayers`). The editor offers
stock maps (listed from installed `.vpk`s) plus a **persisted workshop-map
catalog** and a **saved-config library**, both in SQLite (`backend/src/servers/
store.js`, tables `server_workshop_maps` + `server_configs`, migration `002`):

- **Workshop maps** are added/renamed/removed via the `/maps` endpoints; the
  panel only shows the Map-Name field while adding a new ID. The active map is
  still the `host_workshop_map` cvar.
- **Saved configs** (e.g. bunnyhop) are edited via the `/configs` endpoints. The
  selected config is "deployed" by writing its body to
  `serverfiles/game/csgo/cfg/gamertown/active.cfg` and ensuring `cs2server.cfg`
  ends with `exec gamertown/active`; the instance cfg records the choice in
  `gt_active_config`. So map **and** config both apply on the next restart.

**Changes apply on the next restart.** Cvar I/O: `servers/cvars.js` (Source cfg)
and `servers/cfgvars.js` (shell vars).

**Factorio quick settings (save management / world generation):**
`servers.html` shows a three-section editor backed by
`GET/PUT /api/servers/factorio/settings`.

*Save file layout (verified):*
| Path | Contents |
|---|---|
| `serverfiles/saves/<name>.zip` | Named (panel-managed) saves |
| `serverfiles/saves/_autosave1-5.zip` | Factorio autosaves (overwritten each cycle) |
| `serverfiles/save1.zip` | Legacy original world — outside `saves/`, not panel-managed |

*Active world — `startparameters` override required:*
LinuxGSM's `_default.cfg` hardcodes the save path and does **not** expand `savename`
into it:
```
startparameters="--bind ${ip} --start-server ${serverfiles}/save1.zip ..."
```
To change the active world the panel overrides `startparameters` (and `savename` for
bookkeeping) in `lgsm/config-lgsm/fctrserver/fctrserver.cfg`, e.g.:
```
savename="WileyWorld"
startparameters="--bind ${ip} --start-server ${serverfiles}/saves/WileyWorld.zip --server-settings ${servercfgfullpath} --port ${port} --rcon-port ${rconport} --rcon-password ${rconpassword}"
```
`${ip}`, `${serverfiles}`, etc. are shell variables expanded by bash when LinuxGSM
sources the config — they must appear as **literal text** in the file.

*Save As:* copies the most recent `_autosave*.zip` (= current game state) to
`saves/<name>.zip`. Does not restart the server.

*Generate New World:* runs `serverfiles/bin/x64/factorio --create saves/<name>.zip
--map-gen-settings <json> [--preset <preset>]`.
- **Requires exclusive lock** — LinuxGSM process must be stopped first; lock file is
  `serverfiles/.lock`. The connector stops the game, creates the world, then restarts.
- **Factorio 2.0 MapGenSize valid strings:** `none`, `very-low`, `low`, `normal`,
  `high`, `very-high` (aliases `big`/`very-big` also work). `large` and `very-large`
  were **removed in 2.0** and cause `Error Util.cpp:81: large isn't valid size value`.
- Presets (`--preset <name>`) affect non-resource settings (tech costs for `marathon`,
  enemy density for `death-world`, etc.). The `--map-gen-settings` JSON overrides
  individual resource settings on top of the preset.

*RCON:* live in-game commands ARE wired (Phase 3, see "Live commands" below).
Factorio RCON is on port 34198; the `rconpassword` defaults to LinuxGSM's
`CHANGE_ME` until overridden in `common.cfg`.

**Join strings:** each server's `connect` info comes from the registry
(`port` + `connect` style) and `PUBLIC_HOST` (env, default `104.177.95.216` —
update if the dynamic WAN IP changes). The panel shows a copy button:
CS `connect 104.177.95.216:27015`, Factorio `104.177.95.216:34197`,
Minecraft `104.177.95.216:25565`.

**Notes / known gaps:**
- The QEMU guest agent executes as **root**; LinuxGSM refuses to run as root, so the
  connectors drop to `miles` via `runuser` (see `connectors/base.js` `runShell`).
  Files written by `agentFileWrite` are root-owned 644 — readable by `miles`. ✓
- **Updates:** CS2 + Factorio use LinuxGSM `update` (SteamCMD + restart). Minecraft
  pulls the latest stable `server.jar` from Mojang's version manifest, backs up the
  old jar, and restarts (see `connectors/minecraft.js` `update()`).
- **Live commands (Phase 3):** the Runtime panel sends live, no-restart commands.
  A tiny embedded Source-RCON client (`backend/src/servers/rcon.js`) runs in-guest
  via `python3` over the guest agent — the command goes as an argv element (never
  a shell) and the password on stdin (never in argv/`ps`). CS2 speaks RCON on the
  game port (27015) and needs `rcon_password` set in `cs2server.cfg`; Factorio on
  34198. Minecraft has no RCON and uses the tmux console, reading output back from
  the log. Curated actions per game: CS2 restart-round / cheats / bunnyhop;
  Factorio `/players`,`/time`; Minecraft list / save.
- **gameStatus (hosting/idle/down):** `LinuxGsmConnector.gameRunning()` checks
  whether the game's registry port is bound via `ss` (LinuxGSM has no working
  `status` subcommand). Minecraft uses `systemctl is-active`.
- **Factorio 2.0 / Space Age** (v2.0.76 build 84451): mods `elevated-rails`,
  `quality`, `space-age` are always active. Map gen settings must use Factorio 2.0
  MapGenSize enum — see above.

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
