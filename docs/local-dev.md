# Local Development Setup

This guide walks through setting up Gamertown locally on your machine for parallel development.

## Quickstart (dev, full stack)

From a fresh clone, **one command** stands up the whole stack **and a working login**:

```powershell
.\tools\gt.ps1 dev --fresh     # Windows
```
```bash
tools/gt.sh dev --fresh        # macOS/Linux
```

`gt dev --fresh` does all of it in order: installs deps, pulls + decrypts secrets from R2
(age prompts for the passphrase — needs a real terminal), **pre-seeds the app DB** into the
volume so login works, builds + starts the full stack (app, Caddy, docker-proxy, 5 game
servers, BlueMap; localhost self-signed + live reload), and waits for `/api/health`. Then open
**https://localhost** (accept the self-signed cert) and sign in. Re-running it is
non-destructive (it preserves `.env.local` keys like `DEV_PUBLIC_HOST` and skips the DB
restore if one already exists — pass `--restore` to force a fresh pull).

To make an existing dev stack look like production again, use **seed-dev**. It pulls the
newest R2 snapshots into the local dev volumes, then dev drifts independently:

```powershell
.\tools\gt.ps1 seed-dev              # app DB + Factorio save + Minecraft world
.\tools\gt.ps1 seed-dev --db         # just the app DB
.\tools\gt.ps1 seed-dev --worlds     # Factorio + Minecraft only
```
```bash
tools/gt.sh seed-dev                 # macOS/Linux equivalent
```

The Minecraft restore replaces the matching world directory in the dev `mc-data` volume
and clears the dev BlueMap render cache by default so `/map/` re-renders from the restored
world. Pass `--keep-bluemap` only if you know the existing dev BlueMap tiles are still valid.

> The app, login, Minecraft and Factorio are usable within minutes; CS2/GMOD/Prop Hunt
> download their game files on first boot (CS2 is ~30GB) — check `gt … dev ps` /
> `gt … dev logs -f counterstrike`.

**Day-to-day** (secrets already set up): `gt … dev` brings the stack up, and any compose
verb passes through — `gt … dev ps`, `gt … dev logs -f app`, `gt … dev down`,
`gt … dev up -d minecraft`.

**Production-equivalent rehearsal** (existing data, prod-shaped — real Origin cert,
`gamertown.solutions`, VAC servers, no nodemon): `gt … dev --prod-like` (or
`gt … dev --prod-like --app` for the app only, no game servers). It tells you whether the
`gamertown.solutions` hosts entry is present.

The dispatcher's mode → {compose files, env-file chain, project name} mapping lives in
[`tools/gt-modes.conf`](../tools/gt-modes.conf) (shared by both `gt.ps1` and `gt.sh`); it
calls the primitives below, which still work standalone. The rest of this guide explains each
step and the other run modes.

> **Under the hood (the original three steps, still valid):** `setup.*` restores **secrets**
> only; the app **database** is a separate R2 backup (`db-restore.*`); `dev.*` builds + starts
> the stack. `gt dev --fresh` simply sequences them (and pre-seeds the DB before `up` instead
> of restarting afterwards).

## Running tests / CI

One command runs **both** suites — the backend suite (`backend/test/*.test.mjs`, in-memory
SQLite, no Docker needed) and the root suite (`tests/*.test.mjs`, which covers the root
`gamble-*.mjs` / `slot-rules.mjs` logic and has no `package.json` of its own):

```bash
tools/gt.sh test            # Linux/macOS/keeper   (Windows: .\tools\gt.ps1 test)
```

It installs `backend/node_modules` on first run (via `npm ci`) if missing, runs both suites,
and exits non-zero if **either** fails. This is the exact entrypoint
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push and PR, so a green
local `gt test` means a green CI `test` job. (CI also runs `shellcheck` over the deploy/backup
scripts as an advisory job.)

**Web sessions (Claude Code on the web):** a fresh container has no `backend/node_modules`.
Run [`tools/session-start.sh`](../tools/session-start.sh) once to install them (idempotent, never
blocks), or wire it as a `SessionStart` hook in `.claude/settings.json`:

```json
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "bash tools/session-start.sh" } ] } ] } }
```

## Prerequisites

1. **Docker Desktop** (Windows/Mac) or Docker Engine (Linux)
   - Download: https://www.docker.com/products/docker-desktop
   - Required for building and running containers

The setup script will automatically install **rclone** and **age** for you if they're missing.

**On Windows:** If `rclone` or `age` fail to auto-install, you'll need [Chocolatey](https://chocolatey.org/install) or to install them manually.

## Setup Steps

### 1. Clone the repo and navigate to it

```bash
git clone https://github.com/Cbarr-hub/Cbarr-hub.github.io.git
cd Cbarr-hub.github.io
```

### 2. Run the setup script

The setup script will:
- Install rclone and age (if missing — Windows via winget/Chocolatey)
- Prompt for your R2 credentials (regenerate a token if needed)
- Pull the encrypted secret bundle from R2
- Decrypt it locally (**age** prompts for the passphrase itself)
- Generate `.env.local` for docker compose

**Windows (PowerShell):**
```powershell
.\tools\setup.ps1
```

**macOS/Linux (Bash):**
```bash
bash tools/setup.sh
```

**Windows (Git Bash):**
```bash
bash tools/setup.sh
```

**You'll be prompted for:**

- **R2 Account ID**: Found in your Cloudflare R2 settings (the hex string in your
  S3 endpoint, `https://<account-id>.r2.cloudflarestorage.com`)
- **R2 Access Key ID**: Generate a token if needed (read-only on the
  `gamertown-backups` bucket is enough for a pull)
- **R2 Secret Access Key**: the long hex string only — **not** the Account ID or
  the S3 API URL shown alongside it
- **Age passphrase**: prompted by `age` during decryption — paste the passphrase
  from your password manager (input is hidden)

### 3. Start the app

```bash
docker compose --env-file .env.local up --build
```

This builds the backend + Caddy images and starts the stack with the **production**
secrets and cert from the bundle, so Caddy serves `gamertown.solutions` with the real
Cloudflare Origin cert — a faithful rehearsal of the keeper deploy.

To reach it in a browser, map the domain to localhost in your hosts file
(`C:\Windows\System32\drivers\etc\hosts` on Windows, `/etc/hosts` on macOS/Linux;
needs admin/sudo):

```
127.0.0.1 gamertown.solutions www.gamertown.solutions
```

then open **https://gamertown.solutions**. The cert is a Cloudflare Origin cert
(trusted by Cloudflare's edge, not your OS), so the browser will warn — expected for
a local rehearsal.

Quick health check (no hosts entry needed):
```bash
curl -sk --resolve gamertown.solutions:443:127.0.0.1 https://gamertown.solutions/api/health
```

Stop the stack when done:
```bash
docker compose --env-file .env.local down
```

> For active development, use the lighter **dev environment** (localhost + self-signed,
> plus live reload) instead — see [Dev environment](#dev-environment-live-reload) below.

## Troubleshooting

### `rclone: command not found` / `age: command not found`
The setup script attempts to auto-install these. If it fails:
- **macOS**: Ensure Homebrew is installed (https://brew.sh)
- **Linux**: Ensure you have `apt`, `yum`, or `pacman` available
- **Windows**: Manually install rclone (https://rclone.org/install/) and age (https://github.com/FiloSottile/age/releases), then re-run the script

### `Failed to decrypt secrets - wrong passphrase`
The bundle is age **passphrase**-encrypted (scrypt). Double-check the passphrase
from your password manager. The download is **cached** at `.secrets/bundle.age`,
so just re-run the script — it skips the download and credential prompts and goes
straight to the passphrase prompt:
```powershell
.\tools\setup.ps1            # retries against the cached bundle
.\tools\setup.ps1 -Fresh     # forces a re-download + re-entry of R2 credentials
```
(Bash: `bash tools/setup.sh` / `bash tools/setup.sh --fresh`.)

### `403 Forbidden` / `Failed to download secrets from R2`
- Confirm the **Secret Access Key** is the hex string only (a common mistake is
  pasting the Account ID or S3 API URL into that field too).
- Confirm the **Account ID** matches your S3 endpoint
  (`https://<account-id>.r2.cloudflarestorage.com`).
- Confirm the token has access to the `gamertown-backups` bucket.
- Re-running the script overwrites `~/.config/rclone/rclone.conf` (or
  `%APPDATA%\rclone\rclone.conf`) with fresh values, so just run it again.

### On Windows, `bash: tools/setup.sh: command not found`
- Ensure you're in Git Bash or WSL, not PowerShell
- Or use: `bash -c "bash tools/setup.sh"`

## What the setup creates

- **`.secrets/`** — the decrypted bundle, tree preserved as
  `.secrets/etc/gamertown/secrets.env`, `.secrets/root/gamertown/.env`,
  `.secrets/etc/gamertown/certs/` (gitignored)
- **`.env.local`** — env file with `GT_SECRETS_FILE` + `GT_CERTS_DIR` pointing
  into `.secrets/` (gitignored)

These are **not** committed to git and are regenerated from R2 on each setup.

## Dev environment (live reload)

For active development, an override runs the backend under **nodemon** with your source
bind-mounted and Caddy on **localhost** with a self-signed cert — save a file under
`backend/src` and the server restarts automatically, no rebuild.

```bash
docker compose --env-file .env.local -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Then open **https://localhost** (accept the self-signed cert). The API is also exposed
directly at **http://localhost:3000** for non-TLS calls.

How it differs from the production-equivalent run:
- **Caddy**: `SITE_ADDRESS=localhost` + `CADDY_TLS=tls internal` override the bundle's
  production values — no hosts entry, no real cert.
- **App**: built from the Dockerfile `dev` stage (nodemon), `backend/src` bind-mounted.
  nodemon uses `--legacy-watch` (**polling**) because inotify file events don't cross
  Docker Desktop bind mounts on Windows/macOS — plain `node --watch` won't reload there.
- **Secrets**: the same real bundle (via `.env.local`).

> Note: this app-only override does **not** start the Docker socket-proxy or game
> containers, so game-server control is unavailable here (the app logs
> `DOCKER_HOST not configured`). App / forum / UI work all function. For game-server
> control, use the full-stack wrapper below.

Stop it:
```bash
docker compose --env-file .env.local -f docker-compose.yml -f docker-compose.dev.yml down
```

### Full stack with game servers (`tools/dev.ps1`)

To replicate the **whole** production stack locally — the scoped `docker-proxy` (so the
panel's game-server control works) plus all five game containers — use the
`tools/dev.ps1` / `tools/dev.sh` wrapper. It layers `docker-compose.yml` +
`servers.compose.yml` + `docker-compose.dev.yml` and chains the
three env sources compose needs for `${...}` interpolation (`secrets.env` + project
`.env` + `.env.local`):

```powershell
.\tools\dev.ps1                  # up -d --build (default): full stack
.\tools\dev.ps1 ps               # status
.\tools\dev.ps1 logs -f app      # follow a service
.\tools\dev.ps1 up -d minecraft  # just one game
.\tools\dev.ps1 down             # stop everything
```
(Bash: `tools/dev.sh …`.)

Notes:
- The app reaches the engine only through the scoped `docker-proxy`
  (`DOCKER_HOST=tcp://docker-proxy:2375`), never the raw socket.
- Game containers are matched by **name** (`minecraft`, `factorio`, `counterstrike`,
  `gmod`, `prophunt`), as the panel's registry expects.
- **CS2** (`joedwards32/cs2`) is a **~30GB** Steam download — the container appears
  quickly but takes a long time to become RCON-ready. Minecraft + Factorio come up in
  minutes; GMOD/Prop Hunt build the shared `gamertown-gmod` image on first run.
- `SKIP_CSS=1` (from the bundle) skips GMOD's ~3GB CS:S pull; set `$env:SKIP_CSS = "1"`
  to force it if your env differs.

### Connecting to a dev game server (use your LAN IP, not `127.0.0.1`)

Joining a dev game server from a game **client on the same machine** has two gotchas that
don't exist in prod. Both are handled — but you must connect to your machine's **LAN IP,
never `127.0.0.1`**:

1. **Loopback is unreachable from the game client.** A Source/GMOD client binds its socket
   to the host's LAN interface (you'll see `Network: IP 192.168.x.y` in the client console).
   On Windows a socket bound to the LAN IP physically *cannot* send to `127.0.0.1` (loopback
   is a separate interface), so every `connect 127.0.0.1:27066` packet is dropped before it
   reaches Docker — the container sees zero packets. The published port also listens on
   `0.0.0.0`, so the server **is** reachable at `<LAN-IP>:27066`.
2. **VAC/Steam-auth fails over Docker NAT.** A normal (secure) server makes the client present
   a Steam auth ticket that can't validate once the connection is NAT'd through the Docker
   bridge. So the dev `gmod`/`prophunt` containers boot **LAN + insecure** (`LAN_INSECURE=1`
   in `docker-compose.dev.yml` → the entrypoint appends `+sv_lan 1 -insecure` to LinuxGSM's
   launch). The GSLT and Workshop content still work — the entrypoint reuses LinuxGSM's own
   `startparameters` template, so `+sv_setsteamaccount` is untouched.

**Make the panel emit the right join string** — set your LAN IP as `DEV_PUBLIC_HOST` in
`.env.local`, and the panel's join links say `connect <LAN-IP>:27066` directly:

```ini
# .env.local  (find your IP via `ipconfig` or the client's "Network: IP …" line)
DEV_PUBLIC_HOST=192.168.0.228
```

Then in the game console: `connect <LAN-IP>:27066` (TTT) · `:27067` (Prop Hunt). The same
LAN-IP rule applies to any game client on this machine (CS2, Minecraft, Factorio). If a DHCP
lease changes your IP, update `.env.local` (or set a DHCP reservation). `127.0.0.1` still
works for the **web panel/API** (`https://localhost`) — only direct game-client UDP needs the
LAN IP, and the host-side session collector + the panel's RCON control are unaffected (they
reach the containers over the Docker network). **Prod is untouched:** `LAN_INSECURE` is never
set there, so production servers stay VAC-secure and public players auth through Steam normally.

### Database restore (required for login)

`setup.ps1` restores **secrets**, not the app **database** — so a fresh stack boots with
an empty DB and **no users**, and login fails. The DB is a separate R2 backup under the
`app/` path. With the stack up (so the `gt-data` volume exists), pull the newest snapshot
into it:

```powershell
.\tools\db-restore.ps1                                          # newest snapshot, auto-detects the volume
.\tools\db-restore.ps1 -Name gamertown_YYYYMMDD_HHMMSS.sqlite   # a specific snapshot
```

It stops the app, drops the snapshot into the `gt-data` volume (clearing stale WAL/SHM),
chowns it to the app uid, and restarts the app. Verify the users landed:

```powershell
docker exec <project>-app-1 node src/cli.js list-users
```

macOS/Linux: stop the app, then `GT_DATA_VOLUME=<project>_gt-data tools/db-restore.sh`,
then start it. (`<project>` is the compose project name — the lowercased repo dir, e.g.
`cbarr-hubgithubio`.)

Need a brand-new account instead of a restore? Create one interactively:
```bash
docker exec -it <project>-app-1 node src/cli.js create-admin
```

### Production data seed (DB + worlds)

For better pre-deploy testing, `seed-dev` restores the newest production snapshots from R2
into the **dev** compose project volumes:

```powershell
.\tools\gt.ps1 seed-dev
```
```bash
tools/gt.sh seed-dev
```

This restores:
- app DB: `r2:gamertown-backups/app/gamertown_<ts>.sqlite` -> `<project>_gt-data`
- Factorio active save: `r2:gamertown-backups/factorio/_active_<ts>.zip` -> `<project>_factorio-data`
- Minecraft world: `r2:gamertown-backups/minecraft/<level>_<ts>.tar.gz` -> `<project>_mc-data`

Target only one part when the full restore is more than you need:

```powershell
.\tools\gt.ps1 seed-dev --db
.\tools\gt.ps1 seed-dev --factorio
.\tools\gt.ps1 seed-dev --minecraft
.\tools\gt.ps1 seed-dev --worlds
```

Named snapshots are supported:

```powershell
.\tools\gt.ps1 seed-dev --db-name gamertown_YYYYMMDD_HHMMSS.sqlite
.\tools\gt.ps1 seed-dev --factorio-name _active_YYYYMMDD_HHMMSS.zip
.\tools\gt.ps1 seed-dev --minecraft-name world_GTown_YYYYMMDD_HHMMSS.tar.gz
```

The restore stops and restarts affected local containers if they are running. Minecraft
restore also stops BlueMap and clears the **dev** `bluemap-data`/`bluemap-web` caches unless
`--keep-bluemap` is passed, because restored world files make existing dev map tiles stale.
It does not write to production and it is not a live sync.

### Player-session collector (Activity section) in dev

The **Activity** section on the servers panel (live presence + the recent join/leave timeline)
is fed by `tools/gt-session-tracker.mjs`, which in production runs as a **host systemd service**
(`gt-session-tracker.service`) — NOT a compose service. It needs full `docker` + direct DB-volume
access, which the app (behind the scoped `docker-proxy`) deliberately can't reach. So the dev
stack does **not** start it, and the Activity section (and the playtime economy that consumes the
same session rows) stays empty until you run the collector yourself.

To exercise it locally, run it in a throwaway container that mirrors the keeper (host `docker` +
`sqlite3` + the DB volume) on the compose network:

```powershell
docker run -d --name gt-tracker-dev `
  --network <project>_default `
  -v "${PWD}:/repo" `
  -v /var/run/docker.sock:/var/run/docker.sock `
  -v <project>_gt-data:/gtdata `
  --env-file .secrets\etc\gamertown\secrets.env `
  --env-file .secrets\root\gamertown\.env `
  -e GT_DB_PATH=/gtdata/gamertown.sqlite -e GT_POLL_MS=15000 `
  -w /repo docker:cli `
  sh -c "apk add --no-cache nodejs sqlite >/dev/null && exec node tools/gt-session-tracker.mjs"

docker logs -f gt-tracker-dev      # watch joins/leaves
docker rm -f gt-tracker-dev        # stop it
```

(`<project>` is the compose project name — the lowercased repo dir, e.g. `cbarr-hubgithubio`.)
Sessions appear when a player **joins after the collector starts** — the log tail uses
`--tail=0`, so already-online players aren't backfilled. Minecraft/Factorio are read from
`docker logs`; GMOD/Prop Hunt/CS2 from a 15s RCON `status` poll. The host needs `sqlite3 ≥ 3.38`
(the collector probes this at startup).

## Linux notes (verified in a Debian container)

- `setup.sh` must be run in an **interactive terminal**: `age` reads the passphrase
  from `/dev/tty`, not stdin, so it can't run fully unattended. For unattended
  disaster recovery, use an age **identity file** instead of a passphrase.
- Debian's apt `rclone` (1.60.1) is new enough to **download/restore** from R2. The
  keeper's 1.74.2 is only required for backup **uploads** (the `rcat` 501 gotcha).

## For production deployment

On the keeper (Proxmox VM 106) — **one command**, backup-first:
```bash
cd /root/gamertown
tools/gt.sh prod            # predeploy DB snapshot (abort on fail) -> reset to origin/main
                            # -> up -d --build -> health check
#   tools/gt.sh prod --dry-run    # print every resolved command, change nothing
#   tools/gt.sh prod --rollback   # restore predeploy DB + checkout last SHA + redeploy
```

Manual fallback (no pre-deploy backup):
```bash
git pull origin main
COMPOSE="docker compose -f docker-compose.yml -f servers.compose.yml"
$COMPOSE up -d --build
```

No setup script needed there — secrets are already in place at `/etc/gamertown/secrets.env`.
