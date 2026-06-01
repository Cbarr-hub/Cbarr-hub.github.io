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

## Production deploy outline

1. Install Node 20 LTS on the server.
2. Create a dedicated user (`gamertown`) and clone the repo into
   `/srv/gamertown`. The static site is the repo root; the backend lives in
   `backend/`.
3. `cd /srv/gamertown/backend && npm ci --omit=dev`
4. Copy `.env.example` to `.env`, edit values (keep `HOST=127.0.0.1` so only
   Caddy can reach it).
5. `npm run migrate`
6. `node src/cli.js create-admin` — supply username, display name, password.
7. Install the systemd unit from `systemd/gamertown.service.example` to
   `/etc/systemd/system/gamertown.service`, then
   `systemctl enable --now gamertown`.
8. Install Caddy. Drop `Caddyfile.example` into `/etc/caddy/Caddyfile` (edit
   the domain). `systemctl reload caddy`.
9. Point DNS at the box. Caddy will obtain TLS automatically.

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
| GET    | `/api/servers/:id/backups`            | admin    |
| POST   | `/api/servers/:id/backups`            | admin    |
| POST   | `/api/servers/:id/backups/:name/restore` | admin |
| DELETE | `/api/servers/:id/backups/:name`      | admin    |

> Backups (Factorio + Minecraft only) are point-in-time archives pushed offsite to
> Cloudflare R2 via `rclone` running on the game VM — see `INFRA.md` → "Offsite
> backups (rclone → R2)". `GET` returns `{ available, backups[], reason? }`;
> `available:false` means rclone/R2 isn't configured on that VM yet. Counter-Strike
> returns 404 (`NOT_SUPPORTED`). The app never stores R2 credentials.

> Game servers are wired in `src/servers/registry.js` (id → VMID) with a connector
> per game in `src/servers/connectors/`: Counter-Strike (100), Factorio (101),
> Minecraft (102), and **Garry's Mod / TTT (104)**. GMOD reuses the LinuxGSM +
> Source-RCON pattern — `getSettings`/`setSettings` expose the TTT knobs (map,
> workshop collection, round/time limits, traitor & detective ratios + caps, map
> cycle) and the Runtime panel drives it live over RCON. See `INFRA.md` →
> "Game Server VMs" for the in-guest layout.

## What's not here yet

- Seed data for the `games` table (wheel page). The old Supabase rows need
  to be re-entered or imported.
- Display-name editing UI.
