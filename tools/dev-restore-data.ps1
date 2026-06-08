# Restore production backup snapshots into the local dev Docker volumes.
#
# Defaults to all restorable prod data: app DB, Factorio active save, and
# Minecraft world. Use target flags to restore only one part:
#   .\tools\dev-restore-data.ps1
#   .\tools\dev-restore-data.ps1 -Target db
#   .\tools\dev-restore-data.ps1 -Target worlds -KeepBlueMap
#   .\tools\dev-restore-data.ps1 -Target minecraft -MinecraftName world_GTown_YYYYMMDD_HHMMSS.tar.gz
param(
    [string[]]$Target = @(),
    [string]$DbName = '',
    [string]$FactorioName = '',
    [string]$MinecraftName = '',
    [switch]$KeepBlueMap,
    [switch]$Help
)

$ErrorActionPreference = "Continue"

$Repo = Split-Path -Parent $PSScriptRoot
$Conf = Join-Path $PSScriptRoot "gt-modes.conf"
$Remote = if ($env:GT_RCLONE_REMOTE) { $env:GT_RCLONE_REMOTE } else { "r2" }
$Bucket = if ($env:GT_R2_BUCKET) { $env:GT_R2_BUCKET } else { "gamertown-backups" }

function Write-Ok   { Write-Host "[OK] $args" -ForegroundColor Green }
function Write-Err2 { Write-Host "[ERROR] $args" -ForegroundColor Red }
function Write-St   { Write-Host "[*] $args" -ForegroundColor Yellow }

function Usage {
@"
dev-restore-data.ps1 - restore prod backups into local dev volumes

Targets:
  all        app DB + Factorio + Minecraft (default)
  db         app SQLite DB only
  factorio   Factorio saves/_active.zip only
  minecraft  Minecraft world only
  worlds     Factorio + Minecraft

Options:
  -DbName NAME
  -FactorioName NAME
  -MinecraftName NAME
  -KeepBlueMap

Examples:
  .\tools\gt.ps1 seed-dev
  .\tools\gt.ps1 seed-dev --db
  .\tools\gt.ps1 seed-dev --worlds --keep-bluemap
  .\tools\gt.ps1 seed-dev --minecraft-name world_GTown_YYYYMMDD_HHMMSS.tar.gz
"@ | Write-Host
}

if ($Help) { Usage; exit 0 }

function Update-EnvPath {
    $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $user    = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $winget  = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"
    $env:Path = (@($machine, $user, $winget) | Where-Object { $_ }) -join ';'
}

function Conf-Get([string]$key) {
    if (-not (Test-Path $Conf)) { Write-Err2 "missing $Conf"; exit 1 }
    $pat = "^\s*" + [regex]::Escape($key) + "\s*="
    $line = Select-String -LiteralPath $Conf -Pattern $pat | Select-Object -First 1
    if (-not $line) { return ,@() }
    $v = ($line.Line -replace '^[^=]*=', '').Trim()
    if ($v -eq '') { return ,@() }
    return ,($v -split '\s+')
}

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Err2 "$Name not found. Run .\tools\gt.ps1 dev --fresh first."
        exit 1
    }
}

function Expand-Targets([string[]]$Items) {
    if (-not $Items -or $Items.Count -eq 0) { $Items = @("all") }
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($item in $Items) {
        switch ($item.ToLowerInvariant()) {
            "all"       { @("db","factorio","minecraft") | ForEach-Object { if (-not $out.Contains($_)) { $out.Add($_) } } }
            "worlds"    { @("factorio","minecraft") | ForEach-Object { if (-not $out.Contains($_)) { $out.Add($_) } } }
            "db"        { if (-not $out.Contains("db")) { $out.Add("db") } }
            "factorio"  { if (-not $out.Contains("factorio")) { $out.Add("factorio") } }
            "minecraft" { if (-not $out.Contains("minecraft")) { $out.Add("minecraft") } }
            default     { Write-Err2 "unknown target '$item'"; Usage; exit 1 }
        }
    }
    return ,($out.ToArray())
}

function Latest-R2([string]$Prefix, [string]$Pattern) {
    $path = "${Remote}:$Bucket/$Prefix/"
    $items = @(rclone lsf $path 2>$null | Where-Object { $_ -match $Pattern } | Sort-Object)
    if ($LASTEXITCODE -ne 0 -or $items.Count -eq 0) {
        Write-Err2 "no matching backups under $path"
        exit 1
    }
    return $items[$items.Count - 1]
}

function Assert-SnapshotName([string]$Kind, [string]$Name) {
    if (-not $Name) {
        Write-Err2 "$Kind snapshot name resolved empty"
        exit 1
    }
    if ($Name -like '-*') {
        Write-Err2 "invalid $Kind snapshot name '$Name'"
        exit 1
    }
}

function Assert-DownloadedFile([string]$Path, [string]$Label) {
    if (-not (Test-Path $Path)) {
        Write-Err2 "$Label download did not create $Path"
        exit 1
    }
    $file = Get-Item $Path
    if ($file.Length -le 0) {
        Write-Err2 "$Label download is empty"
        exit 1
    }
}

function Write-ContainerScript([string]$Path, [string]$Content) {
    $lf = ($Content -replace "`r`n", "`n") -replace "`r", "`n"
    if (-not $lf.EndsWith("`n")) { $lf += "`n" }
    $enc = New-Object System.Text.ASCIIEncoding
    [System.IO.File]::WriteAllText($Path, $lf, $enc)
}

function Ensure-Volume([string]$Name) {
    docker volume create $Name | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Err2 "could not create/find Docker volume $Name"; exit 1 }
}

function Stop-IfRunning([string]$Name) {
    $running = @(docker ps -q -f "name=^$Name$")
    if ($running) {
        Write-St "stopping $Name"
        docker stop $Name | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Err2 "failed to stop $Name"; return $null }
        return $true
    }
    return $false
}

function Start-IfWasRunning([string]$Name, [bool]$WasRunning) {
    if ($WasRunning) {
        Write-St "starting $Name"
        docker start $Name | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Host "[WARN] failed to restart $Name; start it manually when ready" -ForegroundColor Yellow }
    }
}

function Restore-Db {
    Ensure-Volume $GtVol
    $params = @{ Volume = $GtVol }
    if ($DbName) { $params.Name = $DbName }
    & (Join-Path $PSScriptRoot "db-restore.ps1") @params
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Restore-Factorio {
    Ensure-Volume $FactorioVol
    $name = if ($FactorioName) { $FactorioName } else { Latest-R2 "factorio" "^_active_.*\.zip$" }
    Assert-SnapshotName "Factorio" $name
    Write-St "Factorio snapshot: $name"
    $dir = Join-Path $TempRoot "factorio"
    $null = New-Item -ItemType Directory -Force -Path $dir
    $dst = Join-Path $dir "_active.zip"
    Remove-Item -Force -ErrorAction SilentlyContinue $dst
    rclone copyto "${Remote}:$Bucket/factorio/$name" $dst
    if ($LASTEXITCODE -ne 0) { Write-Err2 "Factorio snapshot download failed"; exit 1 }
    Assert-DownloadedFile $dst "Factorio snapshot"
    Write-ContainerScript (Join-Path $dir "restore-factorio.sh") @'
set -eu
mkdir -p /factorio/saves
cp /work/_active.zip /factorio/saves/_active.zip
chmod 777 /factorio/saves
chmod 666 /factorio/saves/_active.zip
'@

    $was = Stop-IfRunning "factorio"
    if ($null -eq $was) { exit 1 }
    docker run --rm -v "${FactorioVol}:/factorio" -v "${dir}:/work:ro" alpine sh /work/restore-factorio.sh
    $code = $LASTEXITCODE
    Start-IfWasRunning "factorio" $was
    if ($code -ne 0) { Write-Err2 "Factorio restore failed"; exit $code }
    Write-Ok "restored $name -> ${FactorioVol}:/factorio/saves/_active.zip"
}

function Restore-Minecraft {
    Ensure-Volume $McVol
    $name = if ($MinecraftName) { $MinecraftName } else { Latest-R2 "minecraft" "\.tar\.gz$" }
    Assert-SnapshotName "Minecraft" $name
    Write-St "Minecraft snapshot: $name"
    $dir = Join-Path $TempRoot "minecraft"
    $null = New-Item -ItemType Directory -Force -Path $dir
    $dst = Join-Path $dir "world.tar.gz"
    Remove-Item -Force -ErrorAction SilentlyContinue $dst
    rclone copyto "${Remote}:$Bucket/minecraft/$name" $dst
    if ($LASTEXITCODE -ne 0) { Write-Err2 "Minecraft snapshot download failed"; exit 1 }
    Assert-DownloadedFile $dst "Minecraft snapshot"
    Write-ContainerScript (Join-Path $dir "restore-minecraft.sh") @'
set -eu
top="$(tar -tzf /work/world.tar.gz | head -n 1 | cut -d/ -f1)"
case "$top" in
  ""|/*|.*|*../*) echo "unsafe top-level world dir: $top" >&2; exit 1 ;;
esac
rm -rf "/data/$top"
tar -xzf /work/world.tar.gz -C /data
chmod -R u+rwX,go+rX "/data/$top"
printf "%s" "$top" > /out/level.txt
'@
    Write-ContainerScript (Join-Path $dir "clear-bluemap.sh") @'
set -eu
find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +
find /web -mindepth 1 -maxdepth 1 -exec rm -rf {} +
'@

    if (-not $KeepBlueMap) {
        Ensure-Volume $BlueDataVol
        Ensure-Volume $BlueWebVol
    }
    $mcWas = Stop-IfRunning "minecraft"
    if ($null -eq $mcWas) { exit 1 }
    $blueWas = Stop-IfRunning "bluemap"
    if ($null -eq $blueWas) {
        Start-IfWasRunning "minecraft" $mcWas
        exit 1
    }
    docker run --rm -v "${McVol}:/data" -v "${dir}:/work:ro" -v "${dir}:/out" alpine sh /work/restore-minecraft.sh
    $code = $LASTEXITCODE
    if ($code -eq 0 -and -not $KeepBlueMap) {
        Write-St "clearing dev BlueMap render cache for restored Minecraft world"
        docker run --rm -v "${BlueDataVol}:/data" -v "${BlueWebVol}:/web" -v "${dir}:/work:ro" alpine sh /work/clear-bluemap.sh
        if ($LASTEXITCODE -ne 0) { Write-Host "[WARN] could not clear BlueMap cache; map may show stale dev tiles" -ForegroundColor Yellow }
    }
    Start-IfWasRunning "minecraft" $mcWas
    Start-IfWasRunning "bluemap" $blueWas
    if ($code -ne 0) { Write-Err2 "Minecraft restore failed"; exit $code }

    $level = ""
    $levelFile = Join-Path $dir "level.txt"
    if (Test-Path $levelFile) { $level = (Get-Content $levelFile -Raw).Trim() }
    Write-Ok "restored $name -> ${McVol}:/data/$level"
    if ($level) {
        Write-Host "    Effective MC_LEVEL should be '$level' (check .env.local if Minecraft starts a new world)."
    }
}

Update-EnvPath
Require-Command "docker"
Require-Command "rclone"

$project = (Conf-Get "project.dev")[0]
if (-not $project) { Write-Err2 "project.dev missing in $Conf"; exit 1 }

$GtVol = "${project}_gt-data"
$FactorioVol = "${project}_factorio-data"
$McVol = "${project}_mc-data"
$BlueDataVol = "${project}_bluemap-data"
$BlueWebVol = "${project}_bluemap-web"
$TempRoot = Join-Path $Repo (".secrets\dev-seed-" + [guid]::NewGuid().ToString("N"))
$null = New-Item -ItemType Directory -Force -Path $TempRoot

$targets = Expand-Targets $Target
Write-St "dev project: $project; targets: $($targets -join ', ')"

foreach ($target in $targets) {
    switch ($target) {
        "db"        { Restore-Db }
        "factorio"  { Restore-Factorio }
        "minecraft" { Restore-Minecraft }
    }
}

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $TempRoot
Write-Ok "dev seed complete"
exit 0
