# Local Development Setup

This guide walks through setting up Gamertown locally on your machine for parallel development.

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
# Use the generated .env.local file
docker compose --env-file .env.local up --build
```

The app will be available at:
- **https://localhost** (accept the self-signed cert warning)
- Backend API: `https://localhost/api`

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

## Linux notes (verified in a Debian container)

- `setup.sh` must be run in an **interactive terminal**: `age` reads the passphrase
  from `/dev/tty`, not stdin, so it can't run fully unattended. For unattended
  disaster recovery, use an age **identity file** instead of a passphrase.
- Debian's apt `rclone` (1.60.1) is new enough to **download/restore** from R2. The
  keeper's 1.74.2 is only required for backup **uploads** (the `rcat` 501 gotcha).

## For production deployment

On the keeper (Proxmox VM 106):
```bash
cd /root/gamertown
git pull origin main
COMPOSE="docker compose -f docker-compose.yml -f servers.compose.yml -f mc-mem.override.yml"
$COMPOSE up -d --build
```

No setup script needed there — secrets are already in place at `/etc/gamertown/secrets.env`.
