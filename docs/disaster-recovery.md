# Gamertown — Disaster Recovery

**Last verified:** 2026-06-04 against the live keeper (VM 106).

How to rebuild Gamertown — the website, the app, and all five game servers — from
nothing but **the three things that live off the box**:

| Pillar | Where it lives | Lost if the keeper dies? |
|---|---|---|
| **Code** | GitHub `Cbarr-hub/Cbarr-hub.github.io`, branch `main` | No — it's on GitHub |
| **Data** | Cloudflare **R2** bucket `gamertown-backups` (app DB, game saves) | No — it's offsite |
| **Secrets** | R2 (age-encrypted secret bundle) + **the age passphrase in your password manager** | Only if you lose the passphrase |

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

Secrets sit in **two host files + the TLS cert dir**. `tools/secrets-backup.sh` bundles
**all three** into one age-encrypted tar at
`r2:gamertown-backups/secrets/secrets.tar.age` (run on demand; decrypt needs the
passphrase from your password manager). Restore with `tools/secrets-restore.sh`.

| Source | Path | Holds | In the bundle |
|---|---|---|---|
| App/Caddy env | `/etc/gamertown/secrets.env` (`600`) | `SITE_ADDRESS`, `CADDY_TLS`, 4× `*_RCON_PASSWORD` | ✅ |
| Compose project env | `/root/gamertown/.env` | `GMOD_GSLT`, `PROPHUNT_GSLT`, `GMOD_WORKSHOP_COLLECTION`, `MC_LEVEL=world_GTown`, `SKIP_CSS`, dup RCON pw | ✅ |
| TLS origin cert | `/etc/gamertown/certs/gamertown.solutions.{pem,key}` | Cloudflare Origin cert (the `.key` is sensitive) | ✅ |

Why two env files: the app/Caddy env loads via Compose `env_file`, while the project
`.env` is what Compose reads for game-service **interpolation** (`${GMOD_GSLT}` etc.) —
`env_file` can't feed interpolation, so they stay separate. `secrets.env.example`
documents the env shape.

**Still re-mint on rebuild (not in any backup):**
- **R2 API keys** — live only in the keeper's `~/.config/rclone/rclone.conf`. To *read
  the backups* after a total loss, mint a fresh **Object Read & Write** token in the
  Cloudflare dashboard (R2 → Manage API tokens), scoped to `gamertown-backups`.
- **The age passphrase** — only in your password manager. Lose it and the bundle is
  unrecoverable. (As a fallback the GSLTs + cert are *also* re-issuable — Steam appid
  4000 / Cloudflare → SSL/TLS → Origin Server.)
- **PVE token** — no longer used (the app runs pure-Docker); absent from `secrets.env`.

---

## 3. The R2 backup inventory

Bucket `gamertown-backups`, rclone remote `r2`. Restore reads, never writes the live box.

| Prefix | Contents | Schedule | Retention |
|---|---|---|---|
| `app/gamertown_<ts>.sqlite` | app DB (users, sessions, **server Profiles**) | **weekly Mon 04:00** (`gt-db-backup.timer`) | keep **7** |
| `factorio/_active_<ts>.zip` | Factorio active save (~45 MB) | **weekly Mon 04:00** | keep **3** |
| `minecraft/<level>_<ts>.tar.gz` | MC world (`world_GTown`, ~5 GB gz) | **weekly Mon 04:00** | keep **3** |
| `secrets/secrets.tar.age` | age-encrypted bundle (`secrets.env` + project `.env` + TLS cert) | **on-demand** (after editing secrets) | keep 1 |

`<ts>` = UTC `YYYYMMDD_HHMMSS`. The job is the host script `/usr/local/bin/gt-backup.sh`
(vendored at `tools/gt-backup.sh`; unit files in `tools/systemd/`), run as host **root** —
where rclone + the R2 keys live — so backups are **not** an in-app/panel feature (the app
reaches the engine only through the scoped socket-proxy, with no path to R2). The MC world
is flushed via the container's `rcon-cli` (`save-off` → `save-all flush` → tar → `save-on`)
for a consistent snapshot.

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

**4. Restore secrets + the TLS cert** in one shot — the bundle holds `secrets.env`, the
project `.env`, and the origin cert:
```bash
git clone https://github.com/Cbarr-hub/Cbarr-hub.github.io /root/gamertown   # if not already (step 3)
/root/gamertown/tools/secrets-restore.sh --in-place        # enter the passphrase
# → writes /etc/gamertown/secrets.env, /root/gamertown/.env, /etc/gamertown/certs/*
```
(If the GSLTs ever need refreshing, regenerate at steamgameservers.com / appid 4000.)

**5. TLS cert** — already restored by the bundle in step 4. *(Fallback if you skipped the
bundle: re-issue from Cloudflare → SSL/TLS → Origin Server → Create Certificate.)*

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
  `27067` (PH), `27000-27039` (CS), `34197` (Factorio) — see
  [`infrastructure.md`](infrastructure.md) → *Forwarded ports*.
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
  `gt-data`, start. Defaults to the newest weekly snapshot (7 kept).
- **A game save went bad:** restore from R2 by hand (there's no in-panel restore on
  Docker). Factorio: `rclone copyto` the newest `factorio/_active_<ts>.zip` into the
  `factorio-data` volume's `saves/`. Minecraft: see §4 step 7 (stop `minecraft`, extract
  the newest `minecraft/<level>_<ts>.tar.gz` into `mc-data`, start).
- **You edited `secrets.env`:** re-run the secrets backup so R2 stays current — **in a
  real terminal** (the `age -p` prompt needs a TTY, which the Claude `!` prompt lacks):
  `ssh -t root@192.168.1.241 'bash /root/gamertown/tools/secrets-backup.sh'`
- **Roll the keeper to the latest code:** reconcile its checkout to `main` first (see
  below), then `git -C /root/gamertown pull` + `docker compose … up -d --build`.

---

## 6. Known DR gaps + recommended hardening

Closed since the migration, and what's still loose:

- ✅ **Secret bundle (2026-06-04):** `tools/secrets-backup.sh` now tars `secrets.env` +
  the project `.env` (GSLTs) + the TLS origin cert → one `secrets.tar.age`. Re-run it
  (real terminal, passphrase) after editing any secret so R2 stays current.
- ✅ **Keeper checkout reconciled (2026-06-04):** `/root/gamertown` is back on clean
  `main`; `git pull` deploys work.
- ✅ **MC world now backed up (2026-06-05):** the weekly `gt-backup.sh` includes the
  Minecraft world (flushed via `rcon-cli`, keep 3) — no longer on-demand-only.

Still loose:

1. **R2 keys live only on the keeper.** Fine (re-mint from Cloudflare), but R2 access
   then depends on your Cloudflare login — keep that recoverable.
2. **The age passphrase is the single point of failure** for the secret bundle. If it's
   lost, the offsite copy is unrecoverable. Keep it in your password manager.
3. **Weekly cadence:** backups run weekly (Mon 04:00), so up to a week of app-DB / world
   changes can be lost. Bump `OnCalendar` in `tools/systemd/gt-db-backup.timer` for more
   frequent runs.

---

## 7. Reference — tooling

| Tool | Purpose |
|---|---|
| `tools/gt-backup.sh` + `tools/systemd/gt-db-backup.{timer,service}` | **weekly** app-DB + Factorio save + Minecraft world → R2 (host root; installed at `/usr/local/bin/`) |
| `tools/db-backup.sh` / `tools/db-restore.sh` | portable app-DB snapshot / restore (volume-aware) |
| `tools/secrets-backup.sh` / `tools/secrets-restore.sh` | age-encrypt the secret **bundle** (`secrets.env` + project `.env` + TLS cert) → R2 / restore |

See [`infrastructure.md`](infrastructure.md) for the live architecture and forwarded
ports; [`../CLAUDE.md`](../CLAUDE.md) for the day-to-day ops and game-config gotchas.
