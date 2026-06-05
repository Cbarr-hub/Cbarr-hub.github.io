# Gamertown setup — one-time initialization for a fresh clone (PowerShell version).
# Installs dependencies (rclone, age), prompts for R2 credentials, pulls the secret
# bundle from R2, decrypts it (age prompts for the passphrase), and prepares the
# environment for `docker compose up`.
#
# Usage: .\tools\setup.ps1   (from the repo root, in PowerShell)

$ErrorActionPreference = "Stop"

# ── helpers ───────────────────────────────────────────────────────────────────
function Write-Success { Write-Host "[OK] $args" -ForegroundColor Green }
function Write-Err     { Write-Host "[ERROR] $args" -ForegroundColor Red }
function Write-Status  { Write-Host "[*] $args" -ForegroundColor Yellow }

function Test-Command {
    param([string]$Command)
    $null = Get-Command $Command -ErrorAction SilentlyContinue
    return $?
}

# Write UTF-8 WITHOUT a BOM. Windows PowerShell 5.1's `Set-Content -Encoding UTF8`
# prepends a BOM, which corrupts the first line of an env file (docker --env-file)
# and the [r2] section header in rclone.conf.
function Write-TextNoBom {
    param([string]$Path, [string]$Content)
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $enc)
}

# Re-read PATH from the registry into this process. A tool installed by winget/choco
# during this session (or a previous one) lands on the *persisted* PATH, but the
# current shell's $env:Path is a stale snapshot — so a fresh install isn't visible
# until we refresh. Also include winget's shim dir explicitly.
function Update-EnvPath {
    $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $user    = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $winget  = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"
    $env:Path = (@($machine, $user, $winget) | Where-Object { $_ }) -join ';'
}

Write-Host "=== Gamertown Setup ===" -ForegroundColor Green
Write-Host "This will install dependencies and configure your local environment to pull secrets from R2."
Write-Host ""

# Pick up anything installed in a prior shell before we check for it.
Update-EnvPath

# ── dependency install ────────────────────────────────────────────────────────
function Install-Rclone {
    Write-Status "Checking for rclone..."
    if (Test-Command rclone) { Write-Success "rclone already installed"; return $true }

    Write-Status "rclone not found. Attempting to install..."
    # Pipe installer output to Out-Null: native stdout would otherwise become part
    # of this function's return value, breaking the boolean check at the call site.
    # Success is judged by Test-Command after a PATH refresh, not by exit code
    # (winget's codes for already-installed/no-op are inconsistent).
    if (Test-Command winget) {
        Write-Status "Installing via winget..."
        & winget install Rclone.Rclone -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
        Update-EnvPath
        if (Test-Command rclone) { Write-Success "rclone installed via winget"; return $true }
        Write-Host "  winget did not put rclone on PATH; trying Chocolatey..." -ForegroundColor Gray
    }
    if (Test-Command choco) {
        Write-Status "Installing via Chocolatey..."
        & choco install rclone -y | Out-Null
        Update-EnvPath
        if (Test-Command rclone) { Write-Success "rclone installed"; return $true }
    }

    Write-Host ""
    Write-Err "Could not auto-install rclone (or it isn't on PATH)."
    Write-Host "  Try: winget install Rclone.Rclone   then open a NEW PowerShell and re-run."
    Write-Host "  Or download: https://rclone.org/install/"
    return $false
}

function Install-Age {
    Write-Status "Checking for age..."
    if (Test-Command age) { Write-Success "age already installed"; return $true }

    Write-Status "age not found. Attempting to install..."
    # See Install-Rclone for why output is suppressed and success is by Test-Command.
    if (Test-Command winget) {
        Write-Status "Installing via winget..."
        & winget install FiloSottile.age -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
        Update-EnvPath
        if (Test-Command age) { Write-Success "age installed via winget"; return $true }
        Write-Host "  winget did not put age on PATH; trying Chocolatey..." -ForegroundColor Gray
    }
    if (Test-Command choco) {
        Write-Status "Installing via Chocolatey..."
        & choco install age -y | Out-Null
        Update-EnvPath
        if (Test-Command age) { Write-Success "age installed"; return $true }
    }

    Write-Host ""
    Write-Err "Could not auto-install age (or it isn't on PATH)."
    Write-Host "  Try: winget install FiloSottile.age   then open a NEW PowerShell and re-run."
    Write-Host "  Or download: https://github.com/FiloSottile/age/releases"
    return $false
}

if (-not (Install-Rclone)) { exit 1 }
if (-not (Install-Age))    { exit 1 }
Write-Host ""

# ── R2 credentials → rclone config ────────────────────────────────────────────
Write-Status "R2 Credentials"
$r2_account_id = (Read-Host "R2 Account ID").Trim()
$r2_access_key = (Read-Host "R2 Access Key ID").Trim()
$r2_secret_secure = Read-Host -AsSecureString "R2 Secret Access Key"
$r2_secret_key = ([Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToCoTaskMemUnicode($r2_secret_secure))).Trim()
Write-Host ""

Write-Status "Configuring rclone..."
try {
    $rclone_config_dir = Join-Path $env:APPDATA "rclone"
    $null = New-Item -ItemType Directory -Force -Path $rclone_config_dir
    $rclone_conf = Join-Path $rclone_config_dir "rclone.conf"

    # For Cloudflare R2, rclone's S3 backend needs the account-scoped ENDPOINT URL.
    # There is no `account_id` key in the s3 backend — that was the cause of the 403
    # (requests fell through to AWS). `region = auto` is what R2 expects.
    $r2_endpoint = "https://$r2_account_id.r2.cloudflarestorage.com"
    $config = @"
[r2]
type = s3
provider = Cloudflare
access_key_id = $r2_access_key
secret_access_key = $r2_secret_key
endpoint = $r2_endpoint
region = auto
acl = private
"@
    Write-TextNoBom -Path $rclone_conf -Content $config
    Write-Success "rclone r2 remote configured"
} catch {
    Write-Err "Failed to configure rclone: $_"
    exit 1
}
Write-Host ""

# ── secrets directory ─────────────────────────────────────────────────────────
# $PSScriptRoot is tools/ ; the repo root is its parent.
$repo_root   = Split-Path -Parent $PSScriptRoot
$secrets_dir = Join-Path $repo_root ".secrets"
$null = New-Item -ItemType Directory -Force -Path $secrets_dir
Write-Success "Created secrets directory: $secrets_dir"
Write-Host ""

# ── pull + decrypt + extract ──────────────────────────────────────────────────
# The bundle (built by tools/secrets-backup.sh) stores paths relative to / —
# e.g. etc/gamertown/secrets.env. We extract WITHOUT --strip-components so the
# tree is preserved under .secrets/, then point GT_SECRETS_FILE at the real path.
Write-Status "Pulling secrets from R2..."
$tmp_age = [System.IO.Path]::GetTempFileName()
$tmp_tar = [System.IO.Path]::GetTempFileName()
$ok = $false
try {
    & rclone copyto "r2:gamertown-backups/secrets/secrets.tar.age" $tmp_age
    if ($LASTEXITCODE -ne 0) { throw "Failed to download secrets from R2 - check the credentials and that the token can read the gamertown-backups bucket." }
    Write-Success "Downloaded encrypted secrets"

    # age opens the console directly for the passphrase prompt — do NOT pipe or
    # redirect it. (Piping a passphrase to age's stdin does not work; age reads
    # the controlling terminal.)
    Write-Status "Decrypting secrets (age will prompt for your passphrase)..."
    & age -d -o $tmp_tar $tmp_age
    if ($LASTEXITCODE -ne 0) { throw "Failed to decrypt secrets (wrong passphrase?)." }
    Write-Success "Decrypted secrets"

    Write-Status "Extracting secrets..."
    & tar -xzf $tmp_tar -C $secrets_dir
    if ($LASTEXITCODE -ne 0) { throw "Failed to extract secrets." }
    Write-Success "Extracted secrets"

    $ok = $true
} catch {
    Write-Err $_
} finally {
    # finally always runs (incl. normal completion), so the DECRYPTED tar never
    # lingers in %TEMP%.
    Remove-Item -Force -ErrorAction SilentlyContinue $tmp_age, $tmp_tar
}
if (-not $ok) { exit 1 }
Write-Host ""

# ── locate the extracted secrets + certs ──────────────────────────────────────
$secrets_env_path = Join-Path $secrets_dir "etc" | Join-Path -ChildPath "gamertown" | Join-Path -ChildPath "secrets.env"
if (-not (Test-Path $secrets_env_path)) {
    Write-Err "Expected secrets file not found after extraction: $secrets_env_path"
    Write-Host "  The bundle layout may differ. Contents of ${secrets_dir}:"
    Get-ChildItem -Recurse $secrets_dir | ForEach-Object { Write-Host "    $($_.FullName)" }
    exit 1
}

# Caddy's compose service bind-mounts a certs dir; ensure one exists so the mount
# doesn't fail on a host that never had /etc/gamertown/certs.
$certs_dir = Join-Path $secrets_dir "etc" | Join-Path -ChildPath "gamertown" | Join-Path -ChildPath "certs"
if (-not (Test-Path $certs_dir)) { $null = New-Item -ItemType Directory -Force -Path $certs_dir }

# ── write .env.local (forward slashes, no BOM) ────────────────────────────────
# docker compose --env-file is happier with forward slashes on Windows.
$env_file        = Join-Path $repo_root ".env.local"
$secrets_env_fwd = $secrets_env_path -replace '\\','/'
$certs_dir_fwd   = $certs_dir -replace '\\','/'
$env_content = @"
# Generated by tools/setup.ps1
GT_SECRETS_FILE=$secrets_env_fwd
GT_CERTS_DIR=$certs_dir_fwd
"@
Write-TextNoBom -Path $env_file -Content $env_content
Write-Success "Created $env_file"
Write-Host ""

# ── summary ───────────────────────────────────────────────────────────────────
Write-Host "=== Setup Complete ===" -ForegroundColor Green
Write-Host "Secrets pulled from R2 and decrypted to $secrets_dir."
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. docker compose --env-file .env.local up --build"
Write-Host "  2. Open https://localhost  (accept the self-signed cert warning)"
Write-Host ""
Write-Host "Note: the bundle's secrets.env carries the production SITE_ADDRESS / CADDY_TLS." -ForegroundColor Gray
Write-Host "      Caddy may serve the gamertown.solutions cert locally; the app still works" -ForegroundColor Gray
Write-Host "      at https://localhost. Ask if you want a localhost-only compose override." -ForegroundColor Gray
