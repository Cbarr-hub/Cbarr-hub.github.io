# Restore the app SQLite DB from an R2 snapshot into the dev gt-data volume
# (PowerShell counterpart to tools/db-restore.sh, adapted for the local dev stack).
#
# setup.ps1 restores SECRETS only; the app DATABASE is a separate R2 backup (app/),
# so a fresh local stack boots with an empty DB and NO users — login fails until you
# run this. Bring the stack up first (tools\dev.ps1) so the volume + app container
# exist, then:
#   .\tools\db-restore.ps1                                   # newest snapshot
#   .\tools\db-restore.ps1 -Name gamertown_YYYYMMDD_HHMMSS.sqlite
#   .\tools\db-restore.ps1 -Volume someproject_gt-data       # explicit volume
#
# It stops the app, drops the snapshot into the volume (clearing stale WAL/SHM),
# chowns it to the app uid, and restarts the app.
param(
    [string]$Name = '',
    [string]$Volume = ''
)

$ErrorActionPreference = "Continue"   # docker/rclone progress goes to stderr; don't let it abort

function Update-EnvPath {
    $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $user    = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $winget  = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"
    $env:Path = (@($machine, $user, $winget) | Where-Object { $_ }) -join ';'
}
Update-EnvPath

if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] rclone not found - run tools\setup.ps1 first (it installs rclone)." -ForegroundColor Red
    exit 1
}

# Resolve the target volume.
if (-not $Volume) {
    $cands = @(docker volume ls --format "{{.Name}}" | Where-Object { $_ -match '_gt-data$' })
    if ($cands.Count -eq 0) {
        Write-Host "[ERROR] No *_gt-data volume found. Bring the stack up first: .\tools\dev.ps1" -ForegroundColor Red
        exit 1
    } elseif ($cands.Count -gt 1) {
        Write-Host "[ERROR] Multiple gt-data volumes; pass -Volume <name>:" -ForegroundColor Red
        $cands | ForEach-Object { Write-Host "    $_" }
        exit 1
    }
    $Volume = $cands[0]
}
$project = $Volume -replace '_gt-data$', ''
$app     = "$project-app-1"
Write-Host "[*] Volume: $Volume   app container: $app"

# Resolve the snapshot name (newest if not given).
if (-not $Name) {
    $Name = (rclone lsf "r2:gamertown-backups/app/" 2>$null | Where-Object { $_ -match '\.sqlite$' } | Sort-Object | Select-Object -Last 1)
    if (-not $Name) { Write-Host "[ERROR] No DB backups under r2:gamertown-backups/app/" -ForegroundColor Red; exit 1 }
}
Write-Host "[*] Snapshot: $Name"

# Download to a temp dir (under .secrets, which is gitignored).
$repo   = Split-Path -Parent $PSScriptRoot
$indir  = Join-Path $repo ".secrets\dbrestore"
$null = New-Item -ItemType Directory -Force -Path $indir
rclone copyto "r2:gamertown-backups/app/$Name" (Join-Path $indir "gt.sqlite")
if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] download failed" -ForegroundColor Red; exit 1 }
Write-Host ("[OK] downloaded " + (Get-Item (Join-Path $indir 'gt.sqlite')).Length + " bytes")

# Stop the app (if running) so SQLite isn't mid-write, restore, restart.
$running = @(docker ps -q -f "name=^$app$")
if ($running) { Write-Host "[*] stopping $app"; docker stop $app | Out-Null }

docker run --rm -v "${Volume}:/data" -v "${indir}:/in:ro" alpine `
    sh -c "cp /in/gt.sqlite /data/gamertown.sqlite && rm -f /data/gamertown.sqlite-wal /data/gamertown.sqlite-shm && chown 1000:1000 /data/gamertown.sqlite"
if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] restore into volume failed" -ForegroundColor Red; exit 1 }

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $indir
if ($running) { Write-Host "[*] starting $app"; docker start $app | Out-Null }

Write-Host "[OK] restored $Name -> ${Volume} (gamertown.sqlite)" -ForegroundColor Green
Write-Host "    Verify: docker exec $app node src/cli.js list-users"
