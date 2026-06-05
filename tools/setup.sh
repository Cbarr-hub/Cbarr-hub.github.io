#!/usr/bin/env bash
# Gamertown setup — one-time initialization for a fresh clone.
# Installs dependencies (rclone, age), prompts for R2 credentials, pulls the secret
# bundle from R2, decrypts it (age prompts for the passphrase), and prepares the
# environment for `docker compose up`.
#
# Usage: tools/setup.sh
set -euo pipefail

# Color output
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

echo -e "${GREEN}=== Gamertown Setup ===${NC}"
echo "This will install dependencies and configure your local environment to pull secrets from R2."
echo

# Resolve repo root from the script's own location (not $PWD) so it works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Detect OS
if [[ "$OSTYPE" == "linux-gnu"* ]]; then OS="linux"
elif [[ "$OSTYPE" == "darwin"* ]]; then OS="macos"
elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then OS="windows"
else OS="unknown"; fi

# Install a tool via the platform package manager.
install_tool() {
  local cmd=$1 pkg=$2
  if command -v "$cmd" &>/dev/null; then
    echo -e "${GREEN}✓ $cmd already installed${NC}"; return 0
  fi
  echo -e "${YELLOW}Installing $cmd...${NC}"
  case $OS in
    linux)
      if   command -v apt    &>/dev/null; then sudo apt update && sudo apt install -y "$pkg"
      elif command -v dnf    &>/dev/null; then sudo dnf install -y "$pkg"
      elif command -v yum    &>/dev/null; then sudo yum install -y "$pkg"
      elif command -v pacman &>/dev/null; then sudo pacman -S --noconfirm "$pkg"
      else
        echo -e "${RED}✗ No supported package manager found${NC}"
        echo "  Install manually: https://rclone.org/install/ or https://github.com/FiloSottile/age/releases"
        return 1
      fi ;;
    macos)
      if ! command -v brew &>/dev/null; then
        echo -e "${RED}✗ Homebrew not found${NC}"; echo "  Install Homebrew first: https://brew.sh"; return 1
      fi
      brew install "$pkg" ;;
    windows)
      echo -e "${YELLOW}On Windows, prefer the PowerShell setup (tools\\setup.ps1), which auto-installs via winget.${NC}"
      echo "  Or install $cmd manually, then re-run this script."
      return 1 ;;
    *)
      echo -e "${RED}✗ Unknown OS: $OSTYPE${NC}"; echo "  Install $pkg manually and re-run."; return 1 ;;
  esac
  command -v "$cmd" &>/dev/null && { echo -e "${GREEN}✓ $cmd installed${NC}"; return 0; }
  echo -e "${RED}✗ Failed to install $cmd${NC}"; return 1
}

install_tool rclone rclone || exit 1
install_tool age age || exit 1
echo

# ── secrets directory + bundle cache ──────────────────────────────────────────
secrets_dir="$REPO_ROOT/.secrets"
mkdir -p "$secrets_dir"
bundle="$secrets_dir/bundle.age"   # cached encrypted download (gitignored)

# ── R2 download (skipped when a cached bundle exists) ─────────────────────────
# Re-running to retry a bad passphrase shouldn't re-download or re-prompt for R2
# creds. The cached bundle is reused unless --fresh is passed.
[ "${1:-}" = "--fresh" ] && rm -f "$bundle"

if [ -f "$bundle" ]; then
  echo -e "${GREEN}✓ Using cached bundle: $bundle  (pass --fresh to re-download)${NC}"
else
  # Reuse an existing rclone r2 remote unless --fresh; otherwise prompt. Creds live
  # only in the rclone config (~/.config/rclone/rclone.conf) — never the repo.
  if [ "${1:-}" != "--fresh" ] && rclone listremotes 2>/dev/null | grep -qx "r2:"; then
    echo -e "${GREEN}✓ Reusing existing rclone 'r2' remote  (pass --fresh to re-enter credentials)${NC}"
  else
    echo -e "${YELLOW}R2 Credentials${NC}"
    read -rp  "R2 Account ID: "        r2_account_id
    read -rp  "R2 Access Key ID: "     r2_access_key
    read -rsp "R2 Secret Access Key: " r2_secret_key
    echo; echo
    # For Cloudflare R2, rclone's S3 backend needs the account-scoped ENDPOINT URL.
    # There is no `account_id` key in the s3 backend — omitting the endpoint sends
    # requests to AWS (the 403). `region = auto` is what R2 expects.
    echo -e "${YELLOW}Configuring rclone...${NC}"
    r2_endpoint="https://${r2_account_id}.r2.cloudflarestorage.com"
    rclone config create r2 s3 \
      provider Cloudflare \
      access_key_id "$r2_access_key" \
      secret_access_key "$r2_secret_key" \
      endpoint "$r2_endpoint" \
      region auto \
      acl private \
      --non-interactive >/dev/null
    echo -e "${GREEN}✓ rclone r2 remote configured${NC}"
  fi
  echo

  echo -e "${YELLOW}Downloading secret bundle from R2...${NC}"
  rclone copyto "r2:gamertown-backups/secrets/secrets.tar.age" "$bundle" || {
    rm -f "$bundle"
    echo -e "${RED}✗ Failed to download from R2 — check credentials/bucket access, then re-run with --fresh.${NC}"; exit 1; }
  echo -e "${GREEN}✓ Downloaded encrypted secrets → cached at $bundle${NC}"
fi
echo

# ── decrypt + extract ──────────────────────────────────────────────────────────
# The bundle (tools/secrets-backup.sh) is age scrypt (passphrase) encrypted and
# stores paths relative to / — e.g. etc/gamertown/secrets.env. age prompts on the
# controlling terminal (do NOT pipe a passphrase). Extract WITHOUT --strip-components
# so the tree is preserved. The decrypted tar is removed on exit; the encrypted
# bundle.age is kept as the retry cache.
tmp_tar="$(mktemp)"
trap 'rm -f "$tmp_tar"' EXIT

echo -e "${YELLOW}Decrypting secrets (age will prompt for your passphrase)...${NC}"
age -d -o "$tmp_tar" "$bundle" || {
  echo -e "${RED}✗ Failed to decrypt — wrong passphrase. Re-run to try again (cached bundle, no re-download).${NC}"; exit 1; }
echo -e "${GREEN}✓ Decrypted secrets${NC}"

tar -xzf "$tmp_tar" -C "$secrets_dir" || {
  echo -e "${RED}✗ Failed to extract secrets${NC}"; exit 1; }
echo -e "${GREEN}✓ Extracted secrets${NC}"
echo

# ── locate extracted secrets + certs ──────────────────────────────────────────
secrets_env_path="$secrets_dir/etc/gamertown/secrets.env"
if [ ! -f "$secrets_env_path" ]; then
  echo -e "${RED}✗ Expected secrets file not found after extraction: $secrets_env_path${NC}"
  echo "  Bundle layout may differ. Contents of $secrets_dir:"
  find "$secrets_dir" -type f -printf '    %p\n'
  exit 1
fi

# Ensure a certs dir exists so Caddy's compose bind-mount doesn't fail.
certs_dir="$secrets_dir/etc/gamertown/certs"
mkdir -p "$certs_dir"

# ── write .env.local ──────────────────────────────────────────────────────────
env_file="$REPO_ROOT/.env.local"
cat > "$env_file" <<EOF
# Generated by tools/setup.sh
GT_SECRETS_FILE=$secrets_env_path
GT_CERTS_DIR=$certs_dir
EOF
echo -e "${GREEN}✓ Created $env_file${NC}"
echo

# ── summary ───────────────────────────────────────────────────────────────────
echo -e "${GREEN}=== Setup Complete ===${NC}"
echo "Secrets pulled from R2 and decrypted to $secrets_dir."
echo
echo "Next steps:"
echo "  1. docker compose --env-file .env.local up --build"
echo "  2. Open https://localhost  (accept the self-signed cert warning)"
echo
echo "Note: the bundle's secrets.env carries the production SITE_ADDRESS / CADDY_TLS,"
echo "      so Caddy may serve the gamertown.solutions cert locally; the app still works"
echo "      at https://localhost. Ask if you want a localhost-only compose override."
