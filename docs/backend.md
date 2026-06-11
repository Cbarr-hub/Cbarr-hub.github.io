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
tools/gt.sh prod
```

Use raw `docker compose -f docker-compose.yml -f servers.compose.yml up -d --build`
only as a break-glass path; it skips the predeploy backup and rollback metadata.
Running migrations or `create-admin` manually is first-bootstrap work, not the normal
deploy path for a restored production DB.

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
- Rate limit: route-scoped limits on sensitive public/admin routes, including
  login and anonymous review posting.
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
| GET    | `/api/reviews`                        | public   |
| POST   | `/api/reviews`                        | public   |
| GET    | `/api/auth/gate`                      | public   |
| GET    | `/api/admin/users`                    | admin    |
| POST   | `/api/admin/users`                    | admin    |
| DELETE | `/api/admin/users/:id`                | admin    |
| GET    | `/api/admin/db/tables`                | admin    |
| GET    | `/api/admin/db/tables/:table`         | admin    |
| GET    | `/api/admin/db/query?sql=…`           | admin    |
| GET    | `/api/admin/economy/settings`         | admin    |
| PUT    | `/api/admin/economy/settings`         | admin    |
| GET    | `/api/admin/economy/players`          | admin    |
| GET    | `/api/admin/economy/users`            | admin    |
| PUT    | `/api/admin/economy/players/:playerId/account` | admin |
| POST   | `/api/admin/economy/credit`           | admin    |
| GET    | `/api/servers?mode=quick|full`        | admin    |
| GET    | `/api/servers/node`                   | admin    |
| GET    | `/api/servers/online`                 | admin    |
| GET    | `/api/servers/activity?limit=1..500`  | admin    |
| GET    | `/api/servers/stats?days&tz`          | admin    |
| GET    | `/api/servers/map/status`             | admin    |
| GET    | `/api/servers/:id/map/sessions/:sessionId` | admin |
| GET    | `/api/servers/:id/map/players/:player` | admin   |
| GET    | `/api/servers/:id?mode=quick|full`    | admin    |
| POST   | `/api/servers/:id/actions/:action`    | admin    |
| GET    | `/api/servers/:id/settings`           | admin    |
| PUT    | `/api/servers/:id/settings`           | admin    |
| GET    | `/api/servers/:id/maps`               | admin    |
| POST   | `/api/servers/:id/maps`               | admin    |
| POST   | `/api/servers/:id/maps/sync`          | admin    |
| POST   | `/api/servers/:id/maps/collection`    | admin    |
| PATCH/DELETE | `/api/servers/:id/maps/:workshopId` | admin |
| GET/POST | `/api/servers/:id/configs`          | admin    |
| GET/DELETE | `/api/servers/:id/configs/:configId` | admin  |
| GET    | `/api/servers/:id/profiles`           | admin    |
| GET    | `/api/servers/:id/profiles/schema`    | admin    |
| POST   | `/api/servers/:id/profiles`           | admin    |
| POST   | `/api/servers/:id/profiles/capture`   | admin    |
| GET/PUT/DELETE | `/api/servers/:id/profiles/:profileId` | admin |
| POST   | `/api/servers/:id/profiles/:profileId/apply` | admin |
| GET    | `/api/servers/:id/live`               | admin    |
| POST   | `/api/servers/:id/live/command`       | admin    |
| POST   | `/api/servers/:id/live/action`        | admin    |
| GET    | `/api/servers/:id/config`             | admin    |
| GET    | `/api/servers/:id/config/:file`       | admin    |
| PUT    | `/api/servers/:id/config/:file`       | admin    |
| POST   | `/api/servers/:id/update`             | admin    |

> Backups are **not** an app feature — the app holds no R2 credentials. Production
> backups (app DB + Factorio save + Minecraft world → Cloudflare R2) run from a host
> systemd timer; see [`disaster-recovery.md`](disaster-recovery.md).

> `GET /api/servers/node` is the host snapshot powering the servers-page dashboard:
> it returns `{kind:'docker', …}` from the Docker Engine `/info` (engine/OS/kernel +
> container counts, via the socket-proxy with `INFO=1`) plus a CPU/RAM aggregate of the
> containers. The UI renders it in `servers.html` `renderHost`.

> Game servers are wired in `src/servers/registry.js` — each entry carries a
> `backend: 'docker'` flag + a container-name locator and a `connector` key that
> `src/servers/connectors/index.js` maps to a per-game **spec** (fail-loud if the
> mapping is missing). One engine — `connectors/engine.js` (`GameConnector`) —
> interprets the specs in `connectors/specs/{gmod,prophunt,counterstrike,factorio,minecraft}.js`
> (data tables + the genuinely imperative functions; `prophunt` composes `gmod`'s
> exported shared pieces — no class hierarchy). `routes/servers.js` dispatches every
> per-connector operation through a declarative OPS table
> (`svc.connectorFor(id)[op]`); `src/servers/service.js` keeps only the composites
> (status caches, presence overlay, power aliasing, Pulse shaping, BlueMap status).
> **All five — Counter-Strike, Factorio, Minecraft, Garry's Mod / TTT, Prop Hunt —
> run as Docker containers.** GMOD/PH reuse the LinuxGSM + Source-RCON pattern;
> `getSettings`/profiles expose the TTT/PH knobs (map, workshop collection, round/time
> limits, ratios + caps, map cycle) and the Runtime panel drives them live over RCON
> (TCP). Prop Hunt shows its Workshop collection as read-only in Profiles because
> Apply deliberately does not rewrite the X2Z mount collection. See
> `infrastructure.md` → *Current architecture*.

> **Startup-config profiles** (`server_profiles` + `server_active_profile`,
> migration 003) are named, structured startup configs per server — the durable
> counterpart to the ephemeral live-command layer. The generic lifecycle lives on
> the connector engine (`connectors/engine.js`:
> list/get/create/update/delete/apply/capture + an auto-seeded "Default"); each
> game's spec supplies the semantics via
> `spec.profile.{schema,defaults,validate,apply,capture}`. **All five games (GMOD,
> Prop Hunt, Factorio, CS, Minecraft) are wired.** For GMOD/PH/Minecraft/Factorio, `…/apply` writes the config + marks
> the profile active; the panel pairs it with a restart so boot-only settings mount
> or load. Counter-Strike is the exception: Apply pushes the profile live over RCON
> and does not restart, because persistent boot defaults live in `servers.compose.yml`.
> A game wired for profiles trims its `getSettings` to operations only (or just the
> live-map block) so config doesn't double-render beside the Profiles panel. See
> the CLAUDE.md GMOD gotchas.

> **Presence + Activity** (`/api/servers/online`, `/api/servers/activity`) are
> read-only views over the player-session rows the **host** session-tracker writes
> (`players` + `server_sessions`). `online` is "who is connected right now" (open
> sessions, `left_at IS NULL`); `activity` is the recent join/leave timeline
> (`limit` 1–500). The app never collects sessions — it only reads them; collection
> is a host systemd service (see CLAUDE.md → *Player-session tracking*). The servers
> panel renders these in its standalone **Activity** view.

> **Playtime economy** (`/api/admin/economy/*`, migration 007) turns closed
> game-server sessions into gambling dollars. `GET/PUT /settings` is the admin-editable
> rate (`dollarsPerHour`) + per-session cap (`maxSessionMinutes`); `GET /players` is the
> seen-players roster with lifetime playtime + any linked account; `GET /users` feeds the
> link dropdown; `PUT /players/:playerId/account` links a tracked identity to a site user
> (`userId: null` unlinks); `POST /credit` runs the reconciler on demand. The reconciler
> (`backend/src/economy.js`, decorated as `app.economy`) also runs **once at boot and on a
> 5-minute timer** — it credits each CLOSED, uncredited, LINKED session exactly once
> (idempotent via a `credited_at` marker; the per-session cap bounds each award), and
> linking settles a player's pre-link sessions so only post-link playtime earns. The
> servers panel renders this as the admin **Economy** view.

> **Admin DB viewer** (`/api/admin/db/*`) powers the servers panel's **Data** tab. It is
> **admin-gated and strictly read-only**: `GET /tables` is the schema overview (tables +
> column metadata + row counts), `GET /tables/:table` is a paged/sorted/searched grid
> (server-capped at 200 rows), and `GET /query?sql=…` is a free-form **SELECT-only** box
> that runs on a dedicated read-only connection and is gated on SQLite's `stmt.readonly`
> flag (rejects writes incl. `… RETURNING`). `:table`/`sort` are allowlisted against the
> live schema, and `password_hash` is value-masked + excluded from search/queries. All
> routes are GET (mutation-free → no CSRF).

> **Caddy auth gate** — `GET /api/auth/gate` is the endpoint Caddy's `forward_auth`
> calls on every gated request (returns 204 when logged in, else redirects to
> `/signin.html`). It also gates the embedded BlueMap **Minecraft world map** that Caddy
> reverse-proxies at `/map/*` (see `Caddyfile`).

> **Reviews** (`/api/reviews`, "testimony registry", `reviews.html`) are public +
> anonymous: a review carries a free-text `name`, not a user id, so listing and posting
> need no login (preserving the page's pre-backend Supabase behavior). `POST` is
> CSRF-protected and route-rate-limited.

## What's not here yet

- Seed data for the `games` table (wheel page). The old Supabase rows need
  to be re-entered or imported.
- Display-name editing UI.
