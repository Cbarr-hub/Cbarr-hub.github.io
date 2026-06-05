# Gamertown setup — one-time initialization for a fresh clone (PowerShell version).
# Installs dependencies (rclone, age), prompts for R2 credentials + age passphrase,
# pulls secrets from R2, and prepares the environment for `docker compose up`.
#
# Usage: pwsh tools\setup.ps1 (or right-click in folder, Open with PowerShell)

$ErrorActionPreference = "Stop"

# Color output (PowerShell)
function Write-Success { Write-Host "✓ $args" -ForegroundColor Green }
function Write-Error { Write-Host "✗ $args" -ForegroundColor Red }
function Write-Status { Write-Host $args -ForegroundColor Yellow }

Write-Host "=== Gamertown Setup ===" -ForegroundColor Green
Write-Host "This will install dependencies and configure your local environment to pull secrets from R2."
Write-Host ""

# Check for required tools
function Test-Command {
    param([string]$Command)
    $null = Get-Command $Command -ErrorAction SilentlyContinue
    return $?
}

function Install-Rclone {
    Write-Status "Checking for rclone..."

    if (Test-Command rclone) {
        Write-Success "rclone already installed"
        return $true
    }

    Write-Status "rclone not found. Installing via Chocolatey..."

    if (-not (Test-Command choco)) {
        Write-Host ""
        Write-Error "Chocolatey not installed. Please install rclone manually:"
        Write-Host "  https://rclone.org/install/"
        Write-Host "  (Use the Windows installer or Chocolatey)"
        Write-Host ""
        Write-Host "After installing, re-run this script."
        return $false
    }

    try {
        choco install rclone -y | Out-Null
        Write-Success "rclone installed"
        return $true
    } catch {
        Write-Error "Failed to install rclone: $_"
        return $false
    }
}

function Install-Age {
    Write-Status "Checking for age..."

    if (Test-Command age) {
        Write-Success "age already installed"
        return $true
    }

    Write-Status "age not found. Installing via Chocolatey..."

    if (-not (Test-Command choco)) {
        Write-Host ""
        Write-Error "Chocolatey not installed. Please install age manually:"
        Write-Host "  https://github.com/FiloSottile/age/releases"
        Write-Host "  (Download the Windows binary and add to PATH)"
        Write-Host ""
        Write-Host "After installing, re-run this script."
        return $false
    }

    try {
        choco install age -y | Out-Null
        Write-Success "age installed"
        return $true
    } catch {
        Write-Error "Failed to install age: $_"
        return $false
    }
}

# Install dependencies
if (-not (Install-Rclone)) { exit 1 }
if (-not (Install-Age)) { exit 1 }
Write-Host ""

# Prompt for R2 credentials
Write-Status "R2 Credentials"
$r2_account_id = Read-Host "R2 Account ID"
$r2_access_key = Read-Host "R2 Access Key ID"
$r2_secret_key = Read-Host -AsSecureString "R2 Secret Access Key"
$r2_secret_key_plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToCoTaskMemUnicode($r2_secret_key)
)
Write-Host ""

# Set up rclone config (r2 remote)
Write-Status "Configuring rclone..."
try {
    & rclone config create r2 s3 `
        provider Cloudflare `
        access_key_id $r2_access_key `
        secret_access_key $r2_secret_key_plain `
        account_id $r2_account_id `
        --non-interactive 2>&1 | Out-Null
    Write-Success "rclone r2 remote configured"
} catch {
    Write-Error "Failed to configure rclone: $_"
    exit 1
}
Write-Host ""

# Prompt for age passphrase
Write-Status "Age Encryption"
$age_passphrase = Read-Host -AsSecureString "Age passphrase (for decryption)"
$age_passphrase_plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToCoTaskMemUnicode($age_passphrase)
)
Write-Host ""

# Create secrets directory
$secrets_dir = Join-Path $PSScriptRoot ".." ".secrets"
$null = New-Item -ItemType Directory -Force -Path $secrets_dir
Write-Success "Created secrets directory: $secrets_dir"
Write-Host ""

# Pull and decrypt secrets from R2
Write-Status "Pulling secrets from R2..."
$tmp_age = [System.IO.Path]::GetTempFileName()
$tmp_tar = [System.IO.Path]::GetTempFileName()

try {
    # Download encrypted secrets
    & rclone copyto "r2:gamertown-backups/secrets/secrets.tar.age" $tmp_age 2>&1 | Out-Null
    Write-Success "Downloaded encrypted secrets"

    # Decrypt using age passphrase
    Write-Status "Decrypting secrets..."
    $age_passphrase_plain | & age -d -o $tmp_tar $tmp_age 2>&1 | Out-Null
    Write-Success "Decrypted secrets"

    # Extract to .secrets directory
    Write-Status "Extracting secrets..."
    tar -xzf $tmp_tar -C $secrets_dir --strip-components=2 2>&1 | Out-Null
    Write-Success "Extracted secrets"
} catch {
    Write-Error "Failed to pull/decrypt secrets: $_"
    exit 1
} finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $tmp_age
    Remove-Item -Force -ErrorAction SilentlyContinue $tmp_tar
}
Write-Host ""

# Create .env file with GT_SECRETS_FILE pointing to the local secrets
$root_dir = Split-Path $PSScriptRoot
$env_file = Join-Path $root_dir ".env.local"
$secrets_env_path = Join-Path $secrets_dir "gamertown" "secrets.env"

@"
# Generated by tools/setup.ps1
GT_SECRETS_FILE=$secrets_env_path
"@ | Out-File -FilePath $env_file -Encoding UTF8

Write-Success "Created $env_file"
Write-Host ""

# Summary
Write-Host "=== Setup Complete ===" -ForegroundColor Green
Write-Host "Secrets have been pulled from R2 and decrypted locally."
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Run: docker compose --env-file .env.local up --build"
Write-Host "  2. Access the app at: https://localhost"
Write-Host "  3. (Accept the self-signed cert warning)"
Write-Host ""
