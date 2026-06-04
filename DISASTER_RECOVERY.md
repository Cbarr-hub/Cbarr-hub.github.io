# Gamertown — Disaster Recovery

**Last verified:** 2026-06-04 against the live keeper (VM 106).

How to rebuild Gamertown — the website, the app, and all five game servers — from
nothing but **the three things that live off the box**:

| Pillar | Where it lives | Lost if the keeper dies? |
|---|---|---|
| **Code** | GitHub `Cbarr-hub/Cbarr-hub.github.io`, branch `main` | No — it's on GitHub |
| **Data** | Cloudflare **R2** bucket `gamertown-backups` (app DB, game saves) | No — it's offsite |
| **Secrets** | R2 (age-encrypted `secrets.env`) + **the age passphrase in your password manager** | Only if you lose the passphrase |

If you have GitHub access, your Cloudflare login, and the age passphrase, the whole
stack is recoverable. Everything else (R2 keys, TLS cert, GSLTs) can be re-minted.

---

## 1. What production actually is

A single **Docker host** ("the keeper" = Proxmox VM 106 `gamertown-docker`,
192.168.1.241, MAC `bc:24:11:62:f5:5d`). Nothing else is load-bearing — the Proxmox
host is just the hypervisor, and DR onto *any* Docker host (cloud VM, another
hypervisor, bare metal) works identically.

- **Repo checkout:** `/root/gamertown` (branch `main`).
- **Stack:** `docker compose` project **`gamertown`**, three files:
  `docker-compose.yml` (app + Caddy) + `servers.compose.yml` (5 games) +
  `mc-mem.override.yml`, with a project `.env` for interpolation.
- **8 containers:** `gamertown-app-1`, `gamertown-caddy-1`,
  `gamertown-docker-proxy-1`, `minecraft`, `gmod`, `prophunt`, `counterstrike`,
  `factorio`. All `restart: unless-stopped` (so they self-start on host boot — there
  is no stack systemd unit).
- **8 named volumes** hold all persistent state:

  | Volume | Holds |
  |---|---|
  | `gamertown_gt-data` | app SQLite DB (`gamertown.sqlite`) + session-key |
  | `gamertown_mc-data` | Minecraft world (`world_GTown`) |
  | `gamertown_factorio-data` | Factorio saves (incl. `saves/_active.zip`) |
  | `gamertown_gmod-data` / `_ph-data` / `_cs2-data` | game-server installs (re-installable) |
  | `gamertown_caddy_data` / `_config` | Caddy's issued certs / state |

- **Edge:** `gamertown.solutions` is **Cloudflare-proxied** → the origin is reached
  via the BGW210 **:443 forward to the keeper** (no tunnel). Caddy terminates TLS with
  a **Cloudflare Origin certificate** and gates the site with `forward_auth`.

---

## 2. Where every secret lives (and what's backed up)

⚠️ Secrets are split across **two host files**. Only the first is in the R2 backup today.

**A. `/etc/gamertown/secrets.env`** (root, `600`) — consumed by the **app + Caddy**
(Compose `env_file`). 6 keys: `SITE_ADDRESS`, `CADDY_TLS`, and the four
`*_RCON_PASSWORD` (Minecraft/CS2/GMOD/PropHunt).
→ **Backed up:** age-encrypted to `r2:gamertown-backups/secrets/secrets.env.age`
(run `tools/secrets-backup.sh`; decrypt needs the passphrase from your password
manager). **Verified round-trips** (encrypt → R2 → decrypt == original).

**B. `/root/gamertown/.env`** (the Compose project file) — interpolated into the
**game containers** at `up`. Keys: `GMOD_GSLT`, `PROPHUNT_GSLT`,
`GMOD_WORKSHOP_COLLECTION` (empty), `MC_LEVEL=world_GTown`, `SKIP_CSS=1`, plus
duplicate `*_RCON_PASSWORD`.
→ **NOT backed up.** On rebuild: copy the RCON passwords from `secrets.env`, set the
config values above, and **regenerate the two GSLTs** at
`steamgameservers.com` (appid **4000** for GMOD/Prop Hunt). GSLTs are free and
disposable. `secrets.env.example` documents the full shape.

**Not secrets-in-a-file (re-mint on rebuild):**
- **R2 API keys** — live only in the keeper's `~/.config/rclone/rclone.conf`. To
  *read the backups* after a total loss, mint a fresh **Object Read & Write** token
  in the Cloudflare dashboard (R2 → Manage API tokens), scoped to `gamertown-backups`.
- **TLS origin cert** — `/etc/gamertown/certs/gamertown.solutions.{pem,key}` (not
  backed up; the `.key` is sensitive). Re-issue from Cloudflare → SSL/TLS → Origin
  Server → Create Certificate. (Or keep your own copy in your password manager.)
- **PVE token** — no longer used (the app runs pure-Docker); absent from `secrets.env`.

---

## 3. The R2 backup inventory

Bucket `gamertown-backups`, rclone remote `r2`. Restore reads, never writes the live box.

| Prefix | Contents | Schedule | Retention |
|---|---|---|---|
| `app/gamertown_<ts>.sqlite` | app DB (users, sessions, **server Profiles**) | **nightly 04:00** (`gt-db-backup.timer`) | keep **7** |
| `factorio/_active_<ts>.zip` | Factorio active save (~45 MB) | **nightly 04:00** | keep **3** |
| `minecraft/world_GTown_<ts>.tar.gz` | MC world (~5.4 GB) | **on-demand only** (panel → Backups) | keep 1 |
| `secrets/secrets.env.age` | age-encrypted `secrets.env` | **on-demand** (after editing secrets) | keep 1 |

`<ts>` = UTC `YYYYMMDD_HHMMSS`. The nightly job is the host script
`/usr/local/bin/gt-backup.sh`. ⚠️ **The MC world is NOT in the nightly** (too big for
the free tier) — the newest snapshot is whatever you last pushed from the panel, so
**refresh it before relying on it**; gameplay since that snapshot is not recoverable.

---

## 4. Full rebuild — total loss of the keeper

You need: GitHub access, your **Cloudflare login**, and the **age passphrase**.

**1. Fresh Docker host.** Any Linux box with Docker + Compose v2. Install the helpers:
`rclone` (**≥ 1.66** — Ubuntu's stock 1.60.1 breaks R2 streaming), `age`, `sqlite3`.

**2. Point rclone at R2** with a freshly-minted token (§2):
```bash
rclone config create r2 s3 provider=Cloudflare \
  access_key_id=<NEW_KEY> secret_access_key=<NEW_SECRET> \
  endpoint=https://<account-id>.r2.cloudflarestorage.com no_check_bucket=true
rclone lsf r2:gamertown-backups/        # sanity check
```

**3. Clone the code:**
```bash
git clone https://github.com/Cbarr-hub/Cbarr-hub.github.io /root/gamertown
```

**4. Restore secrets:**
```bash
# secrets.env (file A) — from the age backup
rclone copyto r2:gamertown-backups/secrets/secrets.env.age /tmp/s.age
sudo install -D -m600 /dev/null /etc/gamertown/secrets.env
age -d -o /etc/gamertown/secrets.env /tmp/s.age   # enter the passphrase; rm /tmp/s.age
# project .env (file B) — rebuild by hand (RCON pw from secrets.env + new GSLTs)
cp /root/gamertown/secrets.env.example /root/gamertown/.env   # then fill: GSLTs, RCON, MC_LEVEL=world_GTown, SKIP_CSS=1
```

**5. Restore the TLS cert** to `/etc/gamertown/certs/gamertown.solutions.{pem,key}`
(`600`) — re-issue from Cloudflare if you don't have a copy.

**6. Bring the stack up** (creates the 8 volumes, builds images, starts installing
game files):
```bash
cd /root/gamertown
docker compose -f docker-compose.yml -f servers.compose.yml -f mc-mem.override.yml up -d --build
```

**7. Restore the data into the volumes** (the game containers can keep installing
meanwhile):
```bash
# app DB → gt-data  (7 real users, profiles)
tools/db-restore.sh                       # newest r2:.../app/ snapshot
# Factorio save → factorio-data
rclone copyto "r2:gamertown-backups/factorio/$(rclone lsf r2:gamertown-backups/factorio/ | sort | tail -1)" \
  /tmp/f.zip   # then place into the factorio-data volume's saves/ and set active
# Minecraft world → mc-data  (~5.4 GB; stop mc, swap world dir, start)
rclone copyto "r2:gamertown-backups/minecraft/$(rclone lsf r2:gamertown-backups/minecraft/ | sort | tail -1)" /tmp/w.tgz
docker compose stop minecraft && tar -xzf /tmp/w.tgz -C /var/lib/docker/volumes/gamertown_mc-data/_data/ && docker compose start minecraft
```
GMOD / Prop Hunt / CS2 have **no save to restore** — they reinstall game files on
first boot and mount their Workshop collections (this needs the GSLTs from step 4;
Prop Hunt mounts collection `3737190377`).

**8. Repoint the edge:**
- **BGW210 forwards** → the new host's MAC: `443`, `25565` (MC), `27066` (GMOD),
  `27067` (PH), `27000-27039` (CS), `34197` (Factorio). See
  `INFRA.md` → *"Scripting the BGW210 port-forward"*.
- **Cloudflare DNS** for `gamertown.solutions` points at your WAN IP (unchanged unless
  AT&T re-leased it) — it's proxied, so the origin is just the :443 forward.

**9. Verify:**
```bash
curl -s https://gamertown.solutions/api/health     # {"ok":true}
# sign in as a real user; confirm each game shows "hosting" + a join string
```

---

## 5. Partial recovery (the common cases)

- **App DB corrupted / bad migration / fat-fingered data:**
  `tools/db-restore.sh [gamertown_YYYYMMDD_HHMMSS.sqlite]` — stop app, swap the DB in
  `gt-data`, start. Defaults to the newest nightly snapshot (7 kept).
- **A game save went bad:** panel → the server's **Backups** card → restore (Factorio
  pulls a loadable save; Minecraft swaps the world dir in place).
- **You edited `secrets.env`:** re-run the secrets backup so R2 stays current — **in a
  real terminal** (the `age -p` prompt needs a TTY, which the Claude `!` prompt lacks):
  `ssh -t root@192.168.1.241 'bash /root/gamertown/tools/secrets-backup.sh'`
- **Roll the keeper to the latest code:** reconcile its checkout to `main` first (see
  below), then `git -C /root/gamertown pull` + `docker compose … up -d --build`.

---

## 6. Known DR gaps + recommended hardening

Honest list of what *isn't* watertight today:

1. **Project `.env` (GSLTs) isn't backed up.** Recoverable (regenerate at Steam), but a
   one-step DR would bundle `/root/gamertown/.env` + the origin cert into the age
   backup alongside `secrets.env`. *Recommended:* extend `tools/secrets-backup.sh` to
   `tar` all three → age → R2.
2. **TLS origin key isn't backed up.** Re-issuable from Cloudflare; back it up if you'd
   rather not re-issue under pressure.
3. **MC world is on-demand only.** The nightly skips it (size). Push a fresh world
   snapshot from the panel periodically, or accept losing recent MC progress.
4. **R2 keys live only on the keeper.** Fine (re-mint from Cloudflare), but it means R2
   access itself depends on your Cloudflare login — keep that recoverable.
5. **The age passphrase is the single point of failure** for `secrets.env`. If it's
   lost, the offsite secret copy is unrecoverable. Keep it in your password manager.
6. **Keeper checkout drift:** `/root/gamertown` currently runs on a stale local branch
   with untracked migration files (its *running code* matches `main`, but `git pull`
   won't work cleanly). Reconcile before the next deploy:
   `git -C /root/gamertown fetch origin && git -C /root/gamertown checkout -f main`
   (data is in volumes, so this is safe — it only touches tracked source files).

---

## 7. Reference — tooling

| Tool | Purpose |
|---|---|
| `/usr/local/bin/gt-backup.sh` + `gt-db-backup.timer` | nightly app-DB + Factorio → R2 (on the keeper) |
| `tools/db-backup.sh` / `tools/db-restore.sh` | portable app-DB snapshot / restore (volume-aware) |
| `tools/secrets-backup.sh` / `tools/secrets-restore.sh` | age-encrypt `secrets.env` → R2 / restore |
| panel → **Backups** card | on-demand Factorio + Minecraft world archives |

See `INFRA.md` for the live architecture, the BGW210 scripting recipe, and the R2
backup mechanics; `CLAUDE.md` for the day-to-day ops and game-config gotchas.
