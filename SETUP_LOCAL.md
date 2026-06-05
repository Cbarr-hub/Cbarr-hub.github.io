# Local Development Setup

This guide walks through setting up Gamertown locally on your machine for parallel development.

## Prerequisites

1. **Docker Desktop** (Windows/Mac) or Docker Engine (Linux)
   - Download: https://www.docker.com/products/docker-desktop
   - Required for building and running containers

2. **Git Bash** or **WSL** (on Windows, for running the setup script)
   - Git Bash comes with Git for Windows
   - Or use Windows Subsystem for Linux (WSL2) if available

The setup script will automatically install **rclone** and **age** for you if they're missing.

## Setup Steps

### 1. Clone the repo and navigate to it

```bash
git clone https://github.com/Cbarr-hub/Cbarr-hub.github.io.git
cd Cbarr-hub.github.io
```

### 2. Run the setup script

The setup script will:
- Prompt for your R2 credentials (regenerate a token if needed)
- Prompt for your age encryption passphrase
- Pull encrypted secrets from R2
- Decrypt them locally
- Set up the environment

```bash
# On Windows (Git Bash or WSL):
bash tools/setup.sh

# On macOS/Linux:
./tools/setup.sh
```

**You'll be prompted for:**

- **R2 Account ID**: Found in your Cloudflare R2 settings
- **R2 Access Key ID**: Generate a new one if needed (read-only scope is fine)
- **R2 Secret Access Key**: Paired with the access key
- **Age passphrase**: The decryption passphrase from your password manager

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

### `Failed to decrypt secrets (wrong passphrase?)`
Double-check your age passphrase from your password manager.

### `R2 authentication failed`
Verify your R2 credentials:
- Account ID: visible in Cloudflare dashboard
- Access Key: generate a new one with R2 permissions
- Secret Key: only shown once; regenerate if lost

### On Windows, `bash: tools/setup.sh: command not found`
- Ensure you're in Git Bash or WSL, not PowerShell
- Or use: `bash -c "bash tools/setup.sh"`

## What the setup creates

- **`.secrets/`** — Local decrypted secrets (gitignored)
- **`.env.local`** — Environment file pointing to `.secrets/gamertown/secrets.env`

These are **not** committed to git and are regenerated from R2 on each setup.

## For production deployment

On the keeper (Proxmox VM 106):
```bash
cd /root/gamertown
git pull origin main
COMPOSE="docker compose -f docker-compose.yml -f servers.compose.yml -f mc-mem.override.yml"
$COMPOSE up -d --build
```

No setup script needed there — secrets are already in place at `/etc/gamertown/secrets.env`.
