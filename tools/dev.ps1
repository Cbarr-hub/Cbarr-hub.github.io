# Gamertown dev stack wrapper (PowerShell).
#
# Runs the FULL stack (app + caddy + docker-proxy + all 5 game containers) with the
# dev override (localhost + self-signed + nodemon live reload), chaining the three
# env sources compose needs for ${...} interpolation:
#   .secrets/etc/gamertown/secrets.env   (CS2_RCON_PASSWORD, CS2_GSLT, app/caddy)
#   .secrets/root/gamertown/.env         (MC/GMOD/PH RCON, GSLTs, SKIP_CSS, MC_LEVEL)
#   .env.local                           (GT_SECRETS_FILE, GT_CERTS_DIR)
#
# Run tools/setup.ps1 first (it creates .secrets/ + .env.local). Then:
#   .\tools\dev.ps1                       # up -d --build (default)
#   .\tools\dev.ps1 logs -f app           # follow app logs
#   .\tools\dev.ps1 ps                     # status
#   .\tools\dev.ps1 down                   # stop the stack
#   .\tools\dev.ps1 up -d minecraft        # just one service
#
# Tip: set $env:SKIP_CSS = "1" before the first up to skip GMOD's ~3GB CS:S pull.
#
# NOTE: deliberately NOT $ErrorActionPreference='Stop'. docker compose writes its
# progress ("Pulling", "Building", ...) to stderr; under Stop, PowerShell turns the
# first such line into a terminating error and aborts the compose mid-pull. Success
# is judged by docker's own exit code (propagated via `exit $LASTEXITCODE`).
$ErrorActionPreference = "Continue"

$repo     = Split-Path -Parent $PSScriptRoot
$secrets  = Join-Path $repo ".secrets\etc\gamertown\secrets.env"
$projenv  = Join-Path $repo ".secrets\root\gamertown\.env"
$envlocal = Join-Path $repo ".env.local"

foreach ($f in @($secrets, $projenv, $envlocal)) {
    if (-not (Test-Path $f)) {
        Write-Host "[ERROR] Missing $f - run tools\setup.ps1 first." -ForegroundColor Red
        exit 1
    }
}

$composeArgs = $args
if (-not $composeArgs -or $composeArgs.Count -eq 0) { $composeArgs = @('up', '-d', '--build') }

& docker compose `
    --project-directory $repo `
    --env-file $secrets --env-file $projenv --env-file $envlocal `
    -f (Join-Path $repo 'docker-compose.yml') `
    -f (Join-Path $repo 'servers.compose.yml') `
    -f (Join-Path $repo 'mc-mem.override.yml') `
    -f (Join-Path $repo 'docker-compose.dev.yml') `
    @composeArgs
$code = $LASTEXITCODE

# After a successful `up`, point the user at the local site.
if ($code -eq 0 -and ($composeArgs -contains 'up')) {
    Write-Host ""
    Write-Host "  Gamertown (dev) is up -> " -NoNewline -ForegroundColor Green
    Write-Host "https://localhost" -ForegroundColor Cyan
    Write-Host "  (accept the self-signed cert; logs: .\tools\dev.ps1 logs -f app)" -ForegroundColor DarkGray
}
exit $code
