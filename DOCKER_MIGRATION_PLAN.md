# Migrate Gamertown to a portable Docker stack (+ Docker host-driver)

> **✅ Complete (2026-06-04).** This migration shipped: all five games + the app run as
> Docker containers on the keeper (VM 106), the Proxmox control path was removed, and
> `docker` → `main` merged (PR #5). Kept as the historical design record — current state is
> in [`CLAUDE.md`](CLAUDE.md) / [`INFRA.md`](INFRA.md); the retired Proxmox topology is in
> [`INFRA_LEGACY.md`](INFRA_LEGACY.md).

## Context

Gamertown runs as the web app (static site + Fastify + SQLite + Caddy) in **LXC CT 103**,
controlling **5 game servers on Proxmox QEMU VMs** (CS=100, Factorio=101, Minecraft=102,
GMOD=104, Prop Hunt=105) purely through the **Proxmox VE API**.

The user wants two things: (1) the app **stood up easily anywhere** (host-agnostic, env-driven),
and (2) **adding new game servers to be cheap** — not a per-server VM + LinuxGSM bootstrap.
GitHub Pages is retired, so the static site can be baked into the image.

**Exploration confirmed the seam is clean — and cleaner than the draft assumed.** `BaseConnector`
(`backend/src/servers/connectors/base.js`) consumes the Proxmox transport through a *small, fixed
method surface*: `statusCurrent`, `start`/`stop`/`shutdown`/`reboot`, `agentExec` + `agentExecStatus`,
`agentFileRead` + `agentFileWrite`, plus `nodeStatus` (service-level). The test fake at
`backend/test/servers.test.mjs:13-46` enumerates exactly that surface. So the right seam is **not**
"override transport methods per connector" — it is to make a `DockerClient` that **duck-types those
same method names** and returns the same payload shapes. Then `BaseConnector`, profiles, config
read/write, and RCON plumbing work **unchanged**; only the per-server *locator* (`vmid` → container)
and the game-specific command recipes differ.

**Outcome:** `docker compose up` stands up the app anywhere; new servers are containers (image +
one registry entry); existing Proxmox servers keep working untouched; Minecraft migrates as the
proof case, others follow when ready.

## Implementation status - 2026-06-04

Two implementation patches have now been applied to the repo:

- **Patch 1/2 complete:** added the Docker backend seam, portable app/container deployment artifacts,
  host-side secrets example + backup/restore tooling, DB backup/restore tooling, Docker socket-proxy
  Compose wiring, DockerClient transport, DockerBaseConnector, TCP RCON support, and native Docker
  connectors/profile extraction for Minecraft and Factorio.
- **Patch 2/2 complete:** added the Docker Counter-Strike 2 connector, extracted shared
  Counter-Strike profile/config logic, added CS2 Compose/env wiring, and added focused Docker CS2 tests.
- **Tests pass (blocker cleared):** all 124 backend tests pass on Linux/Node 20+ (the earlier failure
  was a Windows/Node 26 `better-sqlite3` build issue, not a code issue). `git diff --check` clean.
- **Live verification — PASSED end-to-end on a throwaway Docker host (VM), then torn down:**
  - *Phase 1:* images build (native modules + `xcaddy`), `/api/health` ok via Caddy, static site +
    try_files, infra files → 403, real CSRF→login→`/api/me`, and SQLite+session persistence across
    `docker compose down && up`.
  - *Phase 3:* the Minecraft `itzg` container, controlled with **no Proxmox in the loop** — `/api/servers`
    routing, status, profile apply/capture, and live Source-RCON over TCP all verified against the real
    container; the other (proxmox) servers correctly degrade to "backend not configured".
  - *Hybrid:* the containerized app reads live Proxmox VM status read-only via the existing token.
- **Four fixes from verification (two runtime-only, not catchable by static review):**
  1. `docker-compose.yml` — bind the app to `HOST=0.0.0.0`; the `.env` default `127.0.0.1` is correct only
     when Caddy shares the host, but as separate containers Caddy could not reach `app:3000` (every
     `/api/*` was 502).
  2. `servers.compose.yml` — pin `container_name` on the game services to match the registry `container`
     locator; the Docker Engine API finds containers by name (else 404 "no such container").
  3. `servers.compose.yml` — stop publishing Factorio RCON 27015 (reached on the compose network; also
     collided with the CS2 host port 27015).
  4. `backend/.env.example` — comment out `DOCKER_HOST` so running only the base compose doesn't point the
     app at a proxy that isn't up (the servers overlay sets it).
- **Remaining:** the real Minecraft world migration (copy VM 102's world into the container volume, boot,
  validate, flip the registry entry; keep the VM as rollback), then choose the production Docker host.

**Secrets decision (resolved with the user):** the goal is "secrets out of the repo, fewest moving
parts." We evaluated Cloudflare Workers KV (the app's first instinct) but Cloudflare **Secrets Store**
is write-only/Worker-only, and KV would add a boot-time hydrate script, a CLI, a bootstrap token, and a
**new boot-time network failure mode** — complexity that doesn't pay off on a single host. Chosen
instead: a **single host-side secret file consumed via Compose `env_file`**, living outside the repo.
The repo becomes 100% secret-free with *zero code changes* (`env.js` already layers `process.env` over
`.env`). KV/Doppler is documented as the multi-host upgrade path, not built now.

```
            ┌─────────── unchanged above the transport line ───────────┐
 routes/servers.js → service.js → connectors/index.js → BaseConnector
                                                            │ (status/power/exec/file/profiles/rcon)
            ┌───────────────────────────────────────────────┼───────────────┐
            │ this.client = per-server transport, chosen by  │               │
            │ registry `backend` flag                        ▼               ▼
        ProxmoxClient (existing)                       DockerClient (NEW, duck-types ProxmoxClient)
        apiUrl/token → PVE REST                        DOCKER_HOST → Engine API (via socket-proxy)
        locator = vmid                                 locator = container name
            │                                                              │
   CS·Factorio·MC·GMOD·PH VMs                          game containers (servers.compose.yml)
```

---

## Phase 1 — Containerize the web app

No source changes; new build/deploy artifacts only. Static site root = **repo root** (Caddy serves
the `*.html/.css/.js/.png` at top level today).

- **`backend/Dockerfile`** (multi-stage; native modules `better-sqlite3` + `argon2` need a toolchain):
  - *builder*: `node:20-bookworm`, `apt-get install build-essential python3`, `npm ci`.
  - *runtime*: `node:20-bookworm-slim`, non-root `node` user, `WORKDIR /app`, copy `node_modules` +
    `src` + `package.json`, `CMD ["node","src/server.js"]`. Avoid alpine/musl (native-module pain).
  - `EXPOSE 3000`. DB lives in a volume at `/app/data` (env `DB_PATH=./data/...` already resolves there).
- **`Dockerfile.caddy`** (repo root): two-stage — `caddy:2-builder` + `xcaddy build` with the
  `caddy-dns/cloudflare` module (needed for DNS-01 since :80 is blocked), then `FROM caddy:2` copying the
  custom binary, the static site, and `Caddyfile`. Baking the site in (not bind-mounting) makes the image
  portable. (If a real cert is deferred, plain `caddy:2` works for self-signed.)
- **`Caddyfile`** (repo root; container variant of `backend/Caddyfile.example`): a site address using
  `{$SITE_ADDRESS:localhost}` so it defaults to self-signed `tls internal`; `handle /api/* {
  reverse_proxy app:3000 }`; static `root * /srv` + `try_files {path} {path}.html /index.html` +
  `file_server`; `handle /backend/* { respond 403 }`. For a real domain, the `tls` block uses
  `dns cloudflare {$CLOUDFLARE_API_TOKEN}` (DNS-01); unset → `tls internal`. (Keeps the existing
  `/api/*` proxy semantics.)
- **`docker-compose.yml`** (repo root):
  - `app`: `build: ./backend`. `env_file: [backend/.env, ${GT_SECRETS_FILE:-/etc/gamertown/secrets.env}]`
    — tracked non-secret defaults first, host-side secrets last (later file wins; `env.js` then layers
    `process.env` over the repo `.env`). Named volume `gt-data:/app/data` (holds `gamertown.sqlite` +
    `session-key`). No published port (internal `:3000`). `NODE_ENV=production`.
  - `caddy`: `build: { context: ., dockerfile: Dockerfile.caddy }`. Publishes `443:443` (AT&T blocks
    80 → no `:80`). Volumes for `caddy_data` + `caddy_config` (cert persistence). `depends_on: [app]`.
    Same `env_file` as `app` so `SITE_ADDRESS` + `CLOUDFLARE_API_TOKEN` (DNS-01) flow in; absent → the
    Caddyfile's `localhost` + `tls internal` self-signed default applies.
  - Named volumes: `gt-data`, `caddy_data`, `caddy_config`.
- **`.dockerignore`** (repo root): `node_modules`, `backend/node_modules`, `backend/data`, `.env`,
  `*.local`, `SECRETS.local.md`, `.git`, `.claude`. **Do NOT** exclude the served `*.png/.html` — they
  are the site. (A separate `backend/.dockerignore` excludes `data/`, `.env`, `node_modules`.)
- **`backend/.env.example`**: the tracked, **non-secret** defaults (PORT, HOST, DB_PATH, NODE_ENV,
  PVE_API_URL, PVE_NODE, PVE_TOKEN_ID, PUBLIC_HOST, plus the Phase 3 `DOCKER_HOST`). No secret *values*.

This retires the two-clone `git pull` dance: the image is the deploy unit. Proxmox server-control keeps
working as long as the `app` container can reach `PVE_API_URL` (env-driven, already the case).

### Secrets — fewest moving parts (folded into Phase 1, no new code)

One host-side file, consumed via Compose `env_file`; the repo never holds secret values.

- **`/etc/gamertown/secrets.env`** (host, root-owned `chmod 600`, **outside the repo**; path overridable
  via `GT_SECRETS_FILE`). Holds every secret *value*: `PVE_TOKEN_SECRET`, and later
  `MINECRAFT_RCON_PASSWORD`, the R2 access key/secret (for docker-game backups), and the Caddy
  `CLOUDFLARE_API_TOKEN` + `SITE_ADDRESS` for DNS-01. Both `app` and `caddy` reference it via `env_file`.
- **`secrets.env.example`** (repo root, **tracked**): every key with placeholder values + a one-line
  comment each. README gains: "copy to `/etc/gamertown/secrets.env`, fill in, `chmod 600`."
- **Retire `SECRETS.local.md`**: move its GSLT/RCON/R2 values into `/etc/gamertown/secrets.env`; delete
  the repo file (it's already gitignored, but the goal is to stop having repo-resident secret files).
- **`session-key` stays auto-generated** in the `gt-data` volume via the existing
  `loadOrCreateSessionKey` (`session.js:9`) — already out of the repo, nothing to manage or migrate.
- **No `env.js` change**: it already merges `.env` then lets `process.env` (populated from the host
  secret file by Compose) win (`env.js:22-52`). This is the whole reason the host-file approach needs
  zero code.
- **Upgrade path (documented, not built):** if this ever runs on multiple hosts, swap the single
  `env_file` for a boot-time pull from Workers KV or `doppler run` — the seam (env-driven `process.env`)
  is identical, so it's a deploy-wrapper change, not an app change.

### Secrets disaster recovery — encrypted copy in R2 (reuses the existing rclone→R2 pipe)

Survives host death without adding any runtime dependency — these run **on-demand**, never at app boot.

- **`tools/secrets-backup.sh`**: `age` (passphrase or `-r` recipient key) encrypts
  `/etc/gamertown/secrets.env` → `secrets.env.age`, then `rclone copyto secrets.env.age
  r2:gamertown-backups/secrets/secrets.env.age`. Reuses the **same R2 remote + bucket** already used for
  game saves (`INFRA.md` → "Offsite backups"). Run after editing secrets; optionally a systemd
  path-unit watches the file and re-pushes automatically. (`gpg --symmetric` is the no-install fallback
  if `age` isn't wanted.)
- **`tools/secrets-restore.sh`**: `rclone copyto` the blob down → `age -d` with the passphrase →
  `/etc/gamertown/secrets.env` (`chmod 600`). Then `docker compose up`.
- **Why client-side encryption:** R2 objects are readable by anyone holding the R2 token, so encrypting
  with `age` first means the token alone never exposes the keys.
- **DR kit (the only things that must outlive the host — keep in a personal password manager, NOT on the
  host or in the repo):** (1) the **age passphrase/key**; (2) a **scoped read-only R2 token** + bucket
  endpoint to fetch the blob — needed because the *full* R2 creds live inside the encrypted file, so
  restore can't bootstrap from them. With those two values a fresh host is: install docker + age +
  rclone, run `secrets-restore.sh`, `docker compose up`.

## State & persistence — what survives a redeploy (answering "do configs reset each time?")

**No. Set-up-once state persists; only the replaceable code/OS layer is rebuilt.** Every service is two
parts: the **image/container layer** (ephemeral — rebuilt from source on each `--build` or image update,
holds code + OS only) and **named volumes** (durable — survive restarts, recreation, and image updates;
wiped only by an explicit `docker compose down -v`). The design puts all durable state on volumes:

| State | Lives in | Survives redeploy? |
|---|---|---|
| Users, sessions, **server Profiles** (startup configs, migration 003), active-profile pointer | SQLite in `gt-data` | ✅ |
| `session-key` (logins don't drop on deploy) | `gt-data` | ✅ |
| Minecraft world + `server.properties`/whitelist/ops/mods (the first-time setup) | game `/data` volume | ✅ |
| TLS certs (no Let's Encrypt re-issue/rate-limit) | `caddy_data`/`caddy_config` | ✅ |
| App code, Node, OS packages | image layer | ❌ rebuilt (intended) |

**Two config layers, both durable, already kept in sync:** the app's source-of-truth Profiles live in
**SQLite** (`gt-data`); the game's actual on-disk config files live in the **game `/data` volume**.
`applyProfileSettings` writes DB→file (+restart) and `captureProfileSettings` reads file→DB (the
`base.js` profile lifecycle) — neither resets on deploy because both sides are on volumes.

**Lifecycle command semantics:**
- `docker compose up` / `up --build` / `--force-recreate` → recreates containers from the (new) image but
  **re-attaches the same named volumes** → data + worlds + certs intact, only code updates. Normal deploy.
- `docker compose restart` → restarts processes only; nothing touched.
- `docker compose down` → removes containers, **keeps volumes** → safe.
- `docker compose down -v` → **the only state-wiping command** (also deletes volumes) → never in normal ops.

**Host-death recovery of *data* (complements the secrets DR above):** volumes are local, so for full
rebuild-after-host-death the volumes also need an offsite copy. Game **worlds** already back up to R2
(existing rclone feature); **the app SQLite DB gets the same treatment** via a new artifact:

- **`tools/db-backup.sh`**: takes a *consistent* online snapshot (`sqlite3 gamertown.sqlite ".backup
  /tmp/gt.sqlite"` — safe while the app is writing; the slim image lacks the `sqlite3` CLI, so run it from
  a throwaway `docker run --rm -v gt-data:/data … sqlite3` against the volume), then
  `rclone copyto /tmp/gt.sqlite r2:gamertown-backups/app/gamertown_<ts>.sqlite`. Reuses the **same R2
  remote** as worlds + the secrets blob — one backup destination for everything.
- **Scheduling:** a `systemd` timer (e.g. nightly) on the host, or fold it into the existing world-backup
  schedule so DB + saves are captured together. Keep a few timestamped generations for point-in-time.
- **`tools/db-restore.sh`**: `rclone copyto` the latest snapshot down into the `gt-data` volume **before**
  `docker compose up` → users + Profiles + sessions return.
- *(Upgrade option if you later want continuous/point-in-time, not just nightly: a **Litestream**
  sidecar streaming the WAL to R2 — one extra container, near-zero maintenance. Noted, not built.)*

Full fresh-host recovery is then three steps: restore secrets (DR kit) → `db-restore.sh` + pull world
volumes from R2 → `docker compose up`.

## Phase 2 — Docker host-driver seam

Mirror the Proxmox structure so Docker is just another backend behind the same contract.

- **`backend/src/docker/client.js`** — `DockerClient`, sibling of `ProxmoxClient`, **duck-typing its
  consumed surface** (raw HTTP over the Engine API via `undici` — no new dependency; `fetchImpl`
  injectable exactly like `ProxmoxClient` for tests). Connects to `DOCKER_HOST` (e.g.
  `tcp://docker-proxy:2375`). Each method takes a container locator in the `vmid` arg position and
  returns Proxmox-shaped payloads:
  | Method (same name as ProxmoxClient) | Docker Engine API | Returns (Proxmox shape) |
  |---|---|---|
  | `statusCurrent(c)` | `GET /containers/{c}/json` (+`/stats?stream=false`) | `{status:'running'\|'stopped', uptime, cpu, mem, maxmem}` (feeds `normalizeStatus` unchanged) |
  | `start(c)` / `stop(c)` / `shutdown(c)` / `reboot(c)` | `POST .../start` / `/stop` / `/stop` / `/restart` | — |
  | `agentExec(c,{command,input})` | `POST /containers/{c}/exec` + `/exec/{id}/start` (run to completion, capture stream + `input` on stdin) | `{pid}` (synthetic; result stashed) |
  | `agentExecStatus(c,pid)` | (returns stashed result) | `{exited:1, exitcode, 'out-data', 'err-data', 'out-truncated'}` |
  | `agentFileRead(c,file)` | `exec cat` (or `GET /containers/{c}/archive`) | `{content, truncated}` |
  | `agentFileWrite(c,file,content)` | `exec` `tee`/`PUT .../archive` | — |

  The `agentExec`/`agentExecStatus` two-step is **emulated**: `agentExec` runs the exec synchronously,
  stashes `{exitcode,stdout,stderr}` under a synthetic pid; `agentExecStatus` returns it as already
  `exited`. This keeps `BaseConnector.runCommand`'s poll loop (`base.js:82-101`) intact, so
  `runShell` (incl. the `runuser -u <user>` argv) and `rcon.js` flow through unmodified.

- **`backend/src/servers/connectors/docker-base.js`** — `DockerBaseConnector extends BaseConnector`,
  overriding **only** `get vmid()` to return `this.server.container`. Everything else (status, power,
  exec, config, profiles) inherits and routes the container locator through `DockerClient`. This thin
  class is the parent for Docker game connectors and is itself usable for a generic test container.

- **`backend/src/servers/registry.js`** — add per-entry `backend: 'proxmox' | 'docker'` and a locator
  (`vmid` for proxmox, `container` for docker). The existing 5 entries get `backend: 'proxmox'` →
  zero behavior change (tests assert vmids + `length===5`, both preserved). `getServer`/`listServers`
  unchanged.

- **`backend/src/servers/connectors/index.js`** — change `buildConnectors(client, store)` →
  `buildConnectors(clients, store)` where `clients = { proxmox, docker }`. Pick the client per server
  from `server.backend`; skip a server whose backend client is null. Use a **per-backend class map**:
  `CONNECTOR_CLASSES.proxmox` (today's map) and `CONNECTOR_CLASSES.docker` (new; defaults to
  `DockerBaseConnector`). Selection: `(CONNECTOR_CLASSES[server.backend]?.[server.connector]) ?? fallback`.

- **`backend/src/servers/service.js`** — in `createServerService`, build the Proxmox client as today
  **and** a `DockerClient` when `env.DOCKER_HOST` is set (or any registry entry is `backend:'docker'`).
  Pass `{ proxmox, docker }` to `buildConnectors`. `getNodeStatus` stays Proxmox-only (the host
  dashboard is a PVE concept). `server.js:63-73` builds and passes both clients.

- **`backend/src/env.js`** — add `DOCKER_HOST` (default `''` → driver disabled, mirrors the PVE-blank
  degrade) and optional `DOCKER_API_VERSION`. Routed through the same `.env` + `process.env` merge.

- **Compose wiring (scoped socket-proxy, per the user's choice):** add a `docker-proxy` service
  (`tecnativa/docker-socket-proxy`) with **only** `CONTAINERS=1` and `EXEC=1` (+ `POST=1` for
  start/stop/exec) enabled and `/var/run/docker.sock` mounted **read-only into the proxy only**. The
  `app` container gets `DOCKER_HOST=tcp://docker-proxy:2375` — it never touches the raw socket
  (socket ≈ root on host). `DOCKER_HOST` also allows a remote engine later.

- **New-server ergonomics (the priority):** adding a server = (1) add a service to a
  `servers.compose.yml` using a known game image, (2) add one registry entry
  `{ id, name, backend:'docker', container, port, connector }`. No VM, no LinuxGSM. A well-imaged game
  needs only a thin `DockerBaseConnector` subclass (or `DockerBaseConnector` directly for status/power).

## Phase 3 — Migrate Minecraft to a container (the proof case)

- **`backend/src/servers/connectors/docker/minecraft.js`** — `DockerMinecraftConnector extends
  DockerBaseConnector`. Target image **`itzg/minecraft-server`** (mature, env-driven, RCON on 25575,
  worlds under `/data`). Recipe differences from the VM connector:
  - `gameRunning()` → container running == hosting (the container *is* the game; no systemd/tmux).
  - `configFiles` → `/data/server.properties`, `/data/whitelist.json`, `/data/ops.json`, … (read/write
    via inherited `readConfig`/`writeConfig` → `DockerClient.agentFileRead/Write`).
  - Profiles: reuse the **exact** `validateProfileSettings` / `profileSchema` / `applyProfileSettings` /
    `captureProfileSettings` logic from the existing `minecraft.js` (they only touch
    `server.properties` text via `getProp`/`setProp` — host-agnostic). Factor those pure helpers into a
    shared module if it avoids copy-paste; otherwise import.
  - **RCON over TCP, not in-guest python:** `itzg` images don't ship `python3`, and the app can reach
    the container's RCON port directly. Add a small TCP-from-app path (reuse the Source-RCON framing in
    `rcon.js`, but open the socket from Node instead of execing python in the guest). Wire
    `getLive`/`sendCommand` to it with `MINECRAFT_RCON_PASSWORD`, added to `env.js` and supplied by the
    host `secrets.env` (never the repo).
- **`servers.compose.yml`** — add a `minecraft` service (`itzg/minecraft-server`, `EULA=TRUE`, RCON
  enabled, named volume for `/data`, port published/forwarded as today's 25565). Register it
  `{ id:'minecraft-docker' (or flip 'minecraft'), backend:'docker', container:'minecraft', connector:'minecraft', port:25565 }`.
- **World migration:** copy the live world from VM 102 into the new `/data` volume, boot, validate, then
  flip the registry entry. **Keep the Proxmox VM as rollback** until validated.
- **CS / Factorio / GMOD / Prop Hunt stay on Proxmox** for now — each is a future one-line registry flip.
  GMOD/Prop Hunt are the fiddliest (Workshop-mount-at-boot, CS:S content mount, GSLT) and may stay VMs
  indefinitely; the per-server `backend` flag makes that a non-decision for the others.

## Key trade-off (the user's call, already noted)

Containers make new servers cheap + the stack portable, but don't replicate Proxmox per-VM snapshots,
hard RAM isolation, or live-migration. Defensible end-state: **app + light/well-imaged games
(MC/Factorio/CS) in Docker, GMOD/Prop Hunt on Proxmox.** The seam supports either — no server is forced
to migrate.

## Reuse — don't reinvent

- `backend/src/proxmox/client.js` — template for `DockerClient` (incl. the `fetchImpl` injection at
  `client.js:34-50` for tests).
- `backend/src/servers/connectors/base.js` — the contract; **do not change its public surface.**
- `backend/src/servers/connectors/minecraft.js` — profile/properties logic to reuse for the Docker MC.
- `rcon.js` Source-RCON framing (`RCON_PY`) — reuse the wire format for the TCP-from-app path.
- `service.js`, `routes/servers.js`, `store.js`, migrations, profiles — unchanged; already host-agnostic.
- `backend/src/env.js` — route all new config through the existing merge (this is why the host-file
  secret approach needs no code change).
- `backend/src/session.js` `loadOrCreateSessionKey` — keep auto-generating the session key into the
  `gt-data` volume; don't move it into the secret file.

## Verification

- **Phase 1:** `docker compose up --build` on a clean machine → `GET https://localhost/api/health` →
  `{ok:true}`; run the full login flow; `docker compose down && up` → confirm SQLite + sessions persist
  (volume). With `PVE_*` set, `/api/servers` still controls the live Proxmox VMs; blank → 503 (degrade,
  not crash). Build `--platform linux/amd64` if building on an arm Mac for an amd64 host.
  **Secrets:** with `/etc/gamertown/secrets.env` present, confirm `PVE_TOKEN_SECRET` reaches the app
  (server-control works) though it appears in no tracked file; `git grep`/`docker history` show no secret
  values baked into the repo or image; `docker compose config` resolves the secret `env_file`.
  **DR round-trip:** run `secrets-backup.sh`, then in a clean dir run `secrets-restore.sh` using only the
  DR kit (age passphrase + read-only R2 token) and confirm it reproduces `secrets.env` byte-for-byte.
  **DB backup round-trip:** create a user, run `db-backup.sh`, `down -v` (wipe), `db-restore.sh`, `up` →
  the user + any Profiles are back (proves the DB survives total host loss, not just redeploys).
- **Phase 2:** `node --test` — add `backend/test/docker-client.test.mjs` mirroring `servers.test.mjs`'s
  fake-client pattern: inject `fetchImpl`, assert each method hits the right Engine endpoint and maps
  payloads to the Proxmox shape. Then stand up a throwaway `busybox`/`nginx` container, register it
  `backend:'docker'`, and exercise status/start/stop/exec/readConfig/writeConfig end-to-end via
  `/api/servers/:id/*`. Confirm existing `servers.test.mjs` still passes (registry length + vmids).
- **Phase 3:** bring up the MC container, migrate the world volume, flip the registry entry; verify
  status/power, profile apply/capture, raw config read/write, and RCON live commands in the panel, and
  that an external client joins via the rendered join string. Keep the Proxmox VM until validated.

## Gotchas

- Build + run on the **same arch** (`linux/amd64`); native bindings must match the host.
- Keep the compiled bindings (in the image) separate from the DB (in `gt-data`) so a rebuild never
  touches data.
- Socket-proxy scope: grant **only** `CONTAINERS` + `EXEC` + `POST` — nothing else.
- `itzg` images have no `python3`; the in-guest RCON path won't work there → use the TCP-from-app path.
- `getNodeStatus` (host dashboard) is Proxmox-only; leave it returning data only when the PVE client
  exists.
- Never `docker compose down -v` in normal ops — the `-v` deletes the named volumes (DB, worlds, certs).
  Plain `down`/`up`/`--build` keep them. Back volumes up to R2 before any intentional volume teardown.
- Secrets: order `env_file` as `[backend/.env, secrets.env]` so the host file wins; `chmod 600` the host
  file; ensure `.dockerignore` + `.gitignore` exclude any `*.env` except the tracked `secrets.env.example`.
  Removing `SECRETS.local.md` is the goal, but copy its GSLT/RCON/R2 values into the host file *first* —
  those values exist nowhere else.
