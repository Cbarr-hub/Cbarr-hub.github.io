# Gamertown backend

Fastify + SQLite + argon2 backend that the static site talks to via `/api/*`.

## Quick start (local)

```sh
cd backend
npm install
cp .env.example .env
npm run migrate
node src/cli.js create-admin   # creates the first admin account
npm run dev
```

Then serve the static site from the repo root at the same origin (any static
server pointed at `..`) or use Caddy with the example Caddyfile.

## Production deploy (Docker — current)

Production runs as a **`docker compose` stack on the keeper** (Proxmox VM 106): the app
+ Caddy are containers and secrets come from a host file. See
[`infrastructure.md`](infrastructure.md) → *Current architecture* and
[`disaster-recovery.md`](disaster-recovery.md) for the full picture.

```bash
# on the keeper, from /root/gamertown
docker compose -f docker-compose.yml -f servers.compose.yml up -d --build
docker exec -it gamertown-app-1 npm run migrate
docker exec -it gamertown-app-1 node src/cli.js create-admin
```

The app binds `HOST=0.0.0.0` **inside its container** (so the separate Caddy container
can reach it); the host publishes only Caddy's `:443`. Runtime secrets load from
`/etc/gamertown/secrets.env` via Compose `env_file` — never committed.

## CLI

```sh
node src/cli.js create-user     # interactive: username / display name / password
node src/cli.js create-admin    # same, but is_admin = 1
node src/cli.js list-users
node src/cli.js delete-user
```

## Security model

- Passwords: argon2id, min 12 chars at the CLI / admin endpoint.
- Sessions: opaque random IDs in a SQLite `sessions` table; cookie is
  `HttpOnly`, `Secure` (in production), `SameSite=Lax`, sealed by
  `@fastify/secure-session`. 30-day sliding expiry, revocable by deleting
  the row.
- CSRF: double-submit token on every non-GET request. The browser fetches a
  token from `GET /api/csrf` once per page and sends it as `x-csrf-token`.
- Rate limit: 10 login attempts per IP per minute, plus a global 300/min
  fallback on all routes.
- No public sign-up. Accounts are admin-issued via the CLI or
  `POST /api/admin/users`.
- Same-origin: cookies are not cross-site, so there is no CORS surface to
  misconfigure.

## API surface

| Method | Path                                  | Auth     |
|--------|---------------------------------------|----------|
| GET    | `/api/health`                         | public   |
| GET    | `/api/csrf`                           | public   |
| POST   | `/api/auth/login`                     | public   |
| POST   | `/api/auth/logout`                    | session  |
| GET    | `/api/me`                             | session  |
| GET    | `/api/balances`                       | public   |
| GET    | `/api/balances/me`                    | session  |
| POST   | `/api/balances/me`                    | session  |
| GET    | `/api/forum/threads`                  | public   |
| GET    | `/api/forum/threads/:id`              | public   |
| POST   | `/api/forum/threads`                  | session  |
| GET    | `/api/forum/threads/:id/comments`     | public   |
| POST   | `/api/forum/threads/:id/comments`     | session  |
| GET    | `/api/leaderboard`                    | public   |
| POST   | `/api/leaderboard`                    | session  |
| GET    | `/api/events`                         | public   |
| POST   | `/api/events`                         | session  |
| GET    | `/api/games`                          | public   |
| GET    | `/api/admin/users`                    | admin    |
| POST   | `/api/admin/users`                    | admin    |
| DELETE | `/api/admin/users/:id`                | admin    |
| GET    | `/api/servers/node`                   | admin    |
| GET    | `/api/servers/:id/profiles`           | admin    |
| GET    | `/api/servers/:id/profiles/schema`    | admin    |
| POST   | `/api/servers/:id/profiles`           | admin    |
| POST   | `/api/servers/:id/profiles/capture`   | admin    |
| GET/PUT/DELETE | `/api/servers/:id/profiles/:profileId` | admin |
| POST   | `/api/servers/:id/profiles/:profileId/apply` | admin |
| GET    | `/api/servers/:id/sessions`           | admin    |
| GET    | `/api/servers/:id/sessions/online`    | admin    |

> Backups are **not** an app feature — the app holds no R2 credentials. Production
> backups (app DB + Factorio save + Minecraft world → Cloudflare R2) run from a host
> systemd timer; see [`disaster-recovery.md`](disaster-recovery.md).

> `GET /api/servers/node` is the host snapshot powering the servers-page dashboard:
> it returns `{kind:'docker', …}` from the Docker Engine `/info` (engine/OS/kernel +
> container counts, via the socket-proxy with `INFO=1`) plus a CPU/RAM aggregate of the
> containers. The UI renders it in `servers.html` `renderDashboard`.

> Game servers are wired in `src/servers/registry.js` — each entry carries a
> `backend: 'docker'` flag + a container-name locator and a connector in
> `src/servers/connectors/` (Docker variants under `connectors/docker/`).
> **All five — Counter-Strike, Factorio, Minecraft, Garry's Mod / TTT, Prop Hunt —
> run as Docker containers.** GMOD/PH reuse the LinuxGSM + Source-RCON pattern;
> `getSettings`/profiles expose the TTT/PH knobs (map, workshop collection, round/time
> limits, ratios + caps, map cycle) and the Runtime panel drives them live over RCON
> (TCP). See `infrastructure.md` → *Current architecture*.

> **Startup-config profiles** (`server_profiles` + `server_active_profile`,
> migration 003) are named, structured startup configs per server — the durable
> counterpart to the ephemeral live-command layer. The generic lifecycle lives on
> `BaseConnector` (list/get/create/update/delete/apply/capture + an auto-seeded
> "Default"); each game supplies five hooks (`profileSchema`,
> `defaultProfileSettings`, `validateProfileSettings`, `applyProfileSettings`,
> `captureProfileSettings`). **All five games (GMOD, Prop Hunt, Factorio, CS, Minecraft)
> are wired.** `…/apply` writes the config + marks the profile active;
> the panel pairs it with a restart so a GMOD workshop collection actually mounts.
> A game wired for profiles trims its `getSettings` to operations only (or just the
> live-map block) so config doesn't double-render beside the Profiles panel. See
> the CLAUDE.md GMOD gotchas.

## What's not here yet

- Seed data for the `games` table (wheel page). The old Supabase rows need
  to be re-entered or imported.
- Display-name editing UI.
