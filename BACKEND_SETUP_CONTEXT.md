# Gamertown Backend Setup Context

**Commit**: `8153759` on branch `backend-auth`  
**Date**: 2026-05-31  
**Status**: Code complete, not yet deployed or runtime-tested

---

## What Changed

The site moved from direct browser→Supabase calls to a secure Node/Fastify backend that the static site talks to via `/api/*`. All auth is now server-managed with argon2id-hashed passwords, sealed HTTPOnly session cookies, CSRF protection, and rate limiting. Public sign-up is gone — accounts are admin-issued only.

---

## Architecture Overview

```
┌─────────────────────────────────────┐
│  Static Site (repo root)            │
│  - index.html, gamble.html, etc.    │
│  - db.js (fetch /api/* client)      │
│  - auth.js (session from /api/me)   │
└──────────────┬──────────────────────┘
               │ (same-origin /api/*)
               ▼
┌─────────────────────────────────────┐
│  Caddy Reverse Proxy                │
│  - TLS termination                  │
│  - Route / → static files           │
│  - Route /api/* → Fastify           │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Fastify Backend (backend/)         │
│  - Node 20 LTS + Express-like routes│
│  - SQLite database (local file)     │
│  - Session table + sealed cookies   │
│  - argon2id password hashing        │
└─────────────────────────────────────┘
```

**Key Design Decisions:**
- SQLite (not Postgres, not Supabase) — file-based, no external dependency, simple backups
- Sealed session cookies (not JWTs) — revocable, 30-day sliding expiry
- Admin-issued accounts only — no public `/api/auth/signup` endpoint
- Same-origin serving (Caddy proxy) — no CORS surface, cookies just work
- Centralized auth primitives — every HTML page uses `await requireAuth()` once

---

## File Structure

```
backend/
├── package.json                 # Node 20 LTS, Fastify 4, argon2, better-sqlite3
├── .env.example                 # PORT, HOST, DB_PATH, SESSION_KEY_PATH, NODE_ENV
├── .gitignore                   # node_modules/, data/, session-key
├── Caddyfile.example            # Reverse proxy config (copy → /etc/caddy/Caddyfile)
├── README.md                    # This document
├── systemd/
│   └── gamertown.service.example  # Copy → /etc/systemd/system/gamertown.service
└── src/
    ├── server.js                # Fastify bootstrap, plugins, route registration
    ├── db.js                    # SQLite connection + migration runner
    ├── env.js                   # Load .env, validate required vars
    ├── migrate.js               # Run migrations (called by npm run migrate)
    ├── cli.js                   # create-user, create-admin, list-users, delete-user
    ├── seed.js                  # Populate 7 admin users + 17 games (npm run seed)
    ├── session.js               # Session create/destroy/lookup, session key mgmt
    ├── middleware/
    │   └── auth.js              # attachSession hook, requireAuth, requireAdmin
    ├── migrations/
    │   └── 001_init.sql         # Schema: users, sessions, balances, threads, comments, leaderboard, gambling_events, games
    └── routes/
        ├── auth.js              # POST /auth/login, /auth/logout
        ├── me.js                # GET /me (current user)
        ├── balances.js          # GET/POST balance endpoints
        ├── forum.js             # Threads + comments
        ├── leaderboard.js       # Fishtank scores
        ├── events.js            # Gambling events
        ├── games.js             # Wheel games list
        └── admin.js             # Admin user management
```

---

## Deployment Checklist

### 1. Prerequisites
- [ ] Node 20 LTS installed on server
- [ ] Caddy installed (or alternative reverse proxy)
- [ ] Dedicated `gamertown` user created (`useradd -m gamertown`)
- [ ] Repo cloned to `/srv/gamertown` (static site = repo root, backend = `backend/` subdirectory)

### 2. Backend Setup

```bash
# Switch to gamertown user
sudo su gamertown
cd /srv/gamertown/backend

# Install dependencies (production: no dev deps)
npm ci --omit=dev

# Copy and edit .env
cp .env.example .env
# Edit .env:
#   PORT=3000 (internal, only Caddy can reach)
#   HOST=127.0.0.1 (not 0.0.0.0)
#   DB_PATH=./data/gamertown.sqlite
#   SESSION_KEY_PATH=./data/session-key
#   NODE_ENV=production

# Run migrations
npm run migrate

# Optional: seed the original 7 users (Wiley, Miles, Jack, Gabe, Austin, Connor, Patrick) + 17 games
npm run seed
# Or create the first admin manually
node src/cli.js create-admin
#   Username: (e.g., Wiley)
#   Display name: (e.g., Wiley)
#   Password: (min 12 chars; "tree" won't work)

# Verify DB was created
ls -la data/
```

### 3. Systemd Unit

```bash
# As root
sudo cp /srv/gamertown/backend/systemd/gamertown.service.example /etc/systemd/system/gamertown.service

# Edit if paths differ (verify WorkingDirectory, EnvironmentFile, ExecStart)
sudo nano /etc/systemd/system/gamertown.service

# Enable + start
sudo systemctl daemon-reload
sudo systemctl enable gamertown
sudo systemctl start gamertown

# Verify it's running
sudo systemctl status gamertown
sudo journalctl -u gamertown -n 20  # Last 20 lines of logs
```

### 4. Caddy Reverse Proxy

```bash
# As root, backup existing config if present
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.backup

# Copy example and edit domain
sudo cp /srv/gamertown/backend/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
# Change "gamertown.example" to your real domain (e.g., gamertown.online)
# Verify paths: root * /var/www/gamertown (should match actual static site location)

# Reload Caddy (will auto-obtain TLS certificate from Let's Encrypt)
sudo systemctl reload caddy

# Verify TLS certificate was obtained
sudo caddy list-certs
curl https://your-domain.com/api/health  # Should return {"ok":true}
```

### 5. DNS

Point your domain at the server's IP address. Caddy will handle TLS automatically.

---

## Architecture Details

### Session Model

1. **Server-side sessions table**: Each active session is a row in `sessions(id, user_id, expires_at)`
2. **Opaque session ID**: 32 random bytes, encoded as base64url
3. **Sealed cookie**: Session ID is encrypted + MAC'd using `@fastify/secure-session`; cookie is `HttpOnly`, `Secure` (prod), `SameSite=Lax`
4. **Sliding expiry**: 30-day TTL; if accessed in final 7 days, expiry is extended to 30 days again
5. **Revocation**: Delete the row from `sessions` table to immediately invalidate the cookie
6. **No JWTs**: Sessions are revocable, stateful, server-side

### Password Hashing

- Algorithm: argon2id (memory-hard, resistant to GPU cracking)
- Cost: m=65536 (64MB), t=3 (3 iterations), p=4 (parallelism)
- Min length: 12 characters (enforced at admin API / CLI; seed script bypasses this)

### CSRF Protection

- **Method**: Double-submit token
- **Flow**: Browser calls `GET /api/csrf` once, stores token in memory
- **Submission**: On form POST/PUT/DELETE, browser sends token in `x-csrf-token` header
- **Validation**: Fastify verifies token matches sealed cookie
- **Same-origin only**: No CORS, so XSS-from-another-site can't read the token

### Rate Limiting

- **Login endpoint**: 10 attempts per IP per minute
- **Global fallback**: 300 requests per IP per minute on all routes
- **Method**: Memory-based with time-window reset

---

## Database Schema

### users
```sql
id INTEGER PK,
username TEXT UNIQUE NOT NULL COLLATE NOCASE,
display_name TEXT NOT NULL,
password_hash TEXT NOT NULL,
is_admin INTEGER DEFAULT 0,
created_at INTEGER DEFAULT (unixepoch())
```

### sessions
```sql
id TEXT PK,
user_id INTEGER FK REFERENCES users(id) ON DELETE CASCADE,
expires_at INTEGER NOT NULL,
created_at INTEGER DEFAULT (unixepoch())
```

### balances
```sql
user_id INTEGER PK FK REFERENCES users(id) ON DELETE CASCADE,
dollars INTEGER NOT NULL DEFAULT 0
```

### games
```sql
id INTEGER PK,
name TEXT NOT NULL,
players TEXT,
minplayers INTEGER,
maxplayers INTEGER,
time_minutes INTEGER
```

(+ threads, comments, leaderboard, gambling_events tables — see `src/migrations/001_init.sql`)

---

## API Endpoints

### Auth (Public)
- **POST /api/auth/login** — `{ username, password }` → sets session cookie
- **POST /api/auth/logout** — destroys session (requires session cookie)
- **GET /api/csrf** — returns `{ token }` (pre-flight for forms)
- **GET /api/me** — returns `{ username, displayName, isAdmin }` or 401

### Balances
- **GET /api/balances** — public leaderboard: `[{ name, dollars }, ...]`
- **GET /api/balances/me** — signed-in user's balance
- **POST /api/balances/me** — update user's balance (body: `{ dollars: int }`)

### Forum
- **GET /api/forum/threads** — list all threads
- **GET /api/forum/threads/:id** — fetch one thread
- **POST /api/forum/threads** — create thread (body: `{ title, body }`)
- **GET /api/forum/threads/:id/comments** — list comments for thread
- **POST /api/forum/threads/:id/comments** — post comment (body: `{ body }`)

### Leaderboard (Fishtank)
- **GET /api/leaderboard?limit=10** — top scores
- **POST /api/leaderboard** — record a score (body: `{ seconds: float }`)

### Events (Gambling)
- **GET /api/events?limit=100&ascending=false** — recent events
- **POST /api/events** — log an event (body: `{ type, payload: object }`)

### Games (Wheel)
- **GET /api/games** — list all games (from seed)

### Admin (requires is_admin=1)
- **GET /api/admin/users** — list all users
- **POST /api/admin/users** — create user (body: `{ username, displayName, password, isAdmin }`)
- **DELETE /api/admin/users/:id** — delete user

### Game Server Control (requires is_admin=1)
Controls the Proxmox game VMs via the PVE API token (see INFRA.md → "Game Server
Control Panel" for setup). Returns 503 if `PVE_TOKEN_*` is unconfigured.
- **GET /api/servers** — list servers + live status/uptime
- **GET /api/servers/:id** — one server's status
- **POST /api/servers/:id/actions/:action** — `action ∈ {start,shutdown,reboot,stop}`
- **GET /api/servers/:id/config** — list whitelisted config files
- **GET /api/servers/:id/config/:file** — read a config file (guest agent)
- **PUT /api/servers/:id/config/:file** — write a config file (guest agent)
- **POST /api/servers/:id/update** — run the game's update recipe (guest agent)

Source: `src/proxmox/client.js` (transport), `src/servers/{registry,service}.js`,
`src/servers/connectors/*` (per-game), `src/routes/servers.js` (HTTP).
Frontend: `servers.html` + `db.js` helpers.

---

## Common Operations

### Create a new user via CLI
```bash
cd /srv/gamertown/backend
node src/cli.js create-admin
# Interactive prompts for username, display name, password
```

### List all users
```bash
node src/cli.js list-users
```

### Delete a user
```bash
node src/cli.js delete-user
# Prompts for username to delete
```

### Re-seed games and initial users
```bash
# WARNING: This uses INSERT OR IGNORE, so existing rows are preserved.
# Safe to re-run.
npm run seed
```

### Check logs
```bash
sudo journalctl -u gamertown -f  # Follow mode
sudo journalctl -u gamertown -n 100  # Last 100 lines
```

### Restart backend
```bash
sudo systemctl restart gamertown
```

### Manual password reset (edit DB directly)
```bash
# ⚠️ Only if you know what you're doing
sqlite3 /srv/gamertown/backend/data/gamertown.sqlite
> DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'username');
> -- User is logged out. CLI will prompt for new password next login? No—need to rehash.
> -- Safer: delete the user and recreate via CLI.
```

---

## Testing

### Test the backend is up
```bash
curl http://localhost:3000/api/health
# Should return {"ok":true}
```

### Test the reverse proxy
```bash
curl https://your-domain.com/api/health
# Should return {"ok":true}
```

### Test login
```bash
curl -X POST https://your-domain.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"Wiley","password":"<password>"}'
# Should set gt_session cookie and return {}
```

### Test CSRF token fetch
```bash
curl https://your-domain.com/api/csrf
# Should return {"token":"..."}
```

### Test read-only endpoints (no auth needed)
```bash
curl https://your-domain.com/api/games
curl https://your-domain.com/api/balances
curl https://your-domain.com/api/leaderboard
```

---

## Troubleshooting

### "Permission denied" when accessing `/srv/gamertown/backend/data/`
→ Ensure the `gamertown` user owns the files:
```bash
sudo chown -R gamertown:gamertown /srv/gamertown/backend/data
```

### "Port already in use" when starting backend
→ Another process is on 3000. Either:
- Stop the other process
- Change PORT in `.env` (and update Caddy config)

### "Session key not found" error
→ `session-key` file wasn't created. Run:
```bash
node src/cli.js create-admin  # This triggers key creation
```

### Caddy won't reload / certificate errors
→ Check syntax:
```bash
sudo caddy validate --config /etc/caddy/Caddyfile
```

### Backend process keeps crashing
→ Check logs:
```bash
sudo journalctl -u gamertown -n 50
```

### "too many login attempts" but I just logged in
→ Rate limiter is per-IP. If multiple machines share an IP (NAT/proxy), they compete. Edit `src/server.js` to adjust rate limit if needed.

---

## What's NOT Implemented Yet

- Display-name editing UI — users can't change their display_name after account creation
- Password reset flow — users can't self-service reset; admin must delete and recreate user via CLI

---

## Browser-Side Changes (Already Done)

All static site HTML + JS has been refactored to use the new backend:
- **db.js**: Thin `/api/*` client (all exports preserved for back-compat)
- **auth.js**: Session loaded from `/api/me`, centralized navbar update, logout via `/api/auth/logout`
- **HTML pages**: Single `await requireAuth()` per page; registration forms removed (admin-issued accounts only)
- **gamble-data.js**: `ensureBalance()` is a no-op (backend seeds 5000 on user creation)

No changes needed to the static HTML files beyond what's in commit `8153759`.

---

## Next Steps

1. Install Node 20 LTS on server
2. Follow the "Deployment Checklist" section above
3. Test endpoints via curl
4. Run the site through a browser to verify all features work
5. Monitor logs for any issues: `sudo journalctl -u gamertown -f`

---

**Questions?** Reference the commit message or backend/README.md for details.
