# gt - Gamertown unified dispatcher (Windows / PowerShell).
#
# One command per mode (the Linux/keeper counterpart is tools/gt.sh):
#   .\tools\gt.ps1 dev --fresh            blank machine -> working dev stack (deps, secrets, DB, up)
#   .\tools\gt.ps1 dev --prod-like        existing data, prod-shaped (real cert, gamertown.solutions)
#   .\tools\gt.ps1 dev --prod-like --app  app only (no game servers)
#   .\tools\gt.ps1 dev <compose args...>  passthrough (ps / logs -f app / down / up -d minecraft)
#   .\tools\gt.ps1 restore-db [name]      restore the app DB from R2
#   .\tools\gt.ps1 prod                   refused here - prod runs on the keeper (see message)
#
# Mode/env/compose mapping lives in tools/gt-modes.conf (shared with gt.sh). This
# dispatcher CALLS the existing primitives (setup.ps1, db-restore.ps1) rather than
# reimplementing the secrets/DB logic.
#
# NOTE: deliberately NOT $ErrorActionPreference='Stop'. docker/git/rclone write
# progress to stderr; under Stop PowerShell turns the first such line into a
# terminating error. Success is judged by the child process exit code.
$ErrorActionPreference = "Continue"

$REPO = Split-Path -Parent $PSScriptRoot
$CONF = Join-Path $PSScriptRoot "gt-modes.conf"

function Write-Ok   { Write-Host "[OK] $args"   -ForegroundColor Green }
function Write-Err2 { Write-Host "[ERROR] $args" -ForegroundColor Red }
function Write-St   { Write-Host "[*] $args"    -ForegroundColor Yellow }

# Re-read PATH from the registry (a tool installed by winget this session lands on
# the persisted PATH but not the live $env:Path). Mirrors setup.ps1 / db-restore.ps1.
function Update-EnvPath {
    $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $user    = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $winget  = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"
    $env:Path = (@($machine, $user, $winget) | Where-Object { $_ }) -join ';'
}

# ---- shared mode config -------------------------------------------------------
function Conf-Get([string]$key) {
    if (-not (Test-Path $CONF)) { Write-Err2 "missing $CONF"; exit 1 }
    $pat = "^\s*" + [regex]::Escape($key) + "\s*="
    $line = Select-String -LiteralPath $CONF -Pattern $pat | Select-Object -First 1
    # The leading unary comma forces an array return. Without it PowerShell unwraps a
    # single-token value (e.g. project.dev = cbarr-hubgithubio) to a bare string, so a
    # caller's [0] would grab the first CHARACTER ('c') instead of the token.
    if (-not $line) { return ,@() }
    $v = ($line.Line -replace '^[^=]*=', '').Trim()
    if ($v -eq '') { return ,@() }
    return ,($v -split '\s+')
}

# Build + run a docker compose invocation for a dev mode. Returns the exit code.
function Invoke-Compose([string]$mode, [string[]]$rest) {
    $proj = (Conf-Get 'project.dev')[0]
    $a = @('compose', '-p', $proj, '--project-directory', $REPO)
    $chainkey = if ($mode -eq 'dev-prodlike-app') { 'env_chain.app' } else { 'env_chain' }
    foreach ($f in (Conf-Get $chainkey)) { $a += @('--env-file', (Join-Path $REPO $f)) }
    foreach ($f in (Conf-Get ("compose." + $mode))) { $a += @('-f', (Join-Path $REPO $f)) }
    if ($rest) { $a += $rest }
    # Out-Host so docker's stdout goes straight to the console instead of joining this
    # function's output stream (which would make the returned value an array, not the code).
    & docker @a | Out-Host
    return $LASTEXITCODE
}

# ---- shared checks ------------------------------------------------------------
$DevSecrets  = Join-Path $REPO ".secrets\etc\gamertown\secrets.env"
$DevProjenv  = Join-Path $REPO ".secrets\root\gamertown\.env"
$DevEnvLocal = Join-Path $REPO ".env.local"
$RconKeys    = @('MINECRAFT_RCON_PASSWORD','CS2_RCON_PASSWORD','GMOD_RCON_PASSWORD','PROPHUNT_RCON_PASSWORD')

function Require-DevFiles {
    $missing = $false
    foreach ($f in @($DevSecrets, $DevProjenv, $DevEnvLocal)) {
        if (-not (Test-Path $f)) { Write-Host "  missing: $f" -ForegroundColor Red; $missing = $true }
    }
    if ($missing) { Write-Err2 "dev secrets not set up. Run: .\tools\gt.ps1 dev --fresh"; exit 1 }
}

function Require-RconKeys {
    foreach ($k in $RconKeys) {
        if (-not (Select-String -LiteralPath $DevSecrets -Pattern "^$k=.+" -Quiet)) {
            Write-Err2 "$k missing/empty in $DevSecrets (needed for compose interpolation)."; exit 1
        }
    }
}

function Poll-Health([string]$label, [string]$url, [string[]]$extra) {
    Write-St "waiting for $label health: $url"
    for ($i = 0; $i -lt 30; $i++) {
        $a = @('-sk', '--max-time', '4')
        if ($extra) { $a += $extra }
        $a += $url
        $out = & curl.exe @a 2>$null
        if ($out -match '"ok":true') { Write-Ok "$label healthy"; return $true }
        Start-Sleep -Seconds 2
    }
    Write-Host "[WARN] $label not healthy after ~60s (it may still be starting)" -ForegroundColor Yellow
    return $false
}

# ---- dev ----------------------------------------------------------------------
function Preseed-Db([bool]$force) {
    $vol = "$((Conf-Get 'project.dev')[0])_gt-data"
    & docker volume create $vol | Out-Null
    if (-not $force) {
        & docker run --rm -v "${vol}:/d" alpine sh -c '[ -s /d/gamertown.sqlite ]' 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-St "$vol already has a DB - skipping restore (pass --restore to force a fresh pull)"
            return
        }
    }
    Write-St "restoring app DB from R2 into $vol (so login works)..."
    & (Join-Path $PSScriptRoot 'db-restore.ps1') -Volume $vol
    if ($LASTEXITCODE -ne 0) { Write-Host "[WARN] DB restore failed - retry later: .\tools\gt.ps1 restore-db" -ForegroundColor Yellow }
}

function Dev-Fresh([bool]$restoreForce) {
    Write-Host "== gt dev --fresh ==" -ForegroundColor Green
    Update-EnvPath
    & (Join-Path $PSScriptRoot 'setup.ps1')         # deps + secrets + .env.local (age prompts)
    if ($LASTEXITCODE -ne 0) { Write-Err2 "setup failed"; exit 1 }
    Update-EnvPath
    Require-DevFiles
    Require-RconKeys
    Preseed-Db $restoreForce
    Write-St "building + starting the dev stack..."
    $code = Invoke-Compose 'dev-fresh' @('up','-d','--build')
    if ($code -ne 0) { Write-Err2 "compose up failed (see output above)."; exit $code }
    [void](Poll-Health 'app' 'https://localhost/api/health' @())
    Write-Host ""
    Write-Ok "Web app + login ready at https://localhost  (accept the self-signed cert)"
    Write-Host "     Game servers download on first boot (CS2 ~30GB) and become joinable later."
    Write-Host "     Status: .\tools\gt.ps1 dev ps      Logs: .\tools\gt.ps1 dev logs -f counterstrike"
}

function Dev-ProdLike([string]$shape) {
    Write-Host "== gt dev --prod-like ($shape) ==" -ForegroundColor Green
    if ($shape -eq 'app') {
        if (-not (Test-Path $DevEnvLocal)) { Write-Err2 ".env.local missing - run: .\tools\gt.ps1 dev --fresh"; exit 1 }
        $mode = 'dev-prodlike-app'
    } else {
        Require-DevFiles; Require-RconKeys
        $mode = 'dev-prodlike'
    }
    $hosts = "$env:WINDIR\System32\drivers\etc\hosts"
    if ((Test-Path $hosts) -and (Select-String -LiteralPath $hosts -Pattern 'gamertown\.solutions' -Quiet)) {
        Write-St "hosts entry present (gamertown.solutions) - good"
    } else {
        Write-Host "[!] hosts entry missing. To browse the site, add (needs Admin), in" -ForegroundColor Yellow
        Write-Host "    $hosts :  127.0.0.1 gamertown.solutions www.gamertown.solutions" -ForegroundColor Yellow
    }
    $code = Invoke-Compose $mode @('up','-d','--build')
    if ($code -ne 0) { Write-Err2 "compose up failed (see output above)."; exit $code }
    [void](Poll-Health 'app' 'https://gamertown.solutions/api/health' @('--resolve','gamertown.solutions:443:127.0.0.1'))
    Write-Ok "prod-like stack up. Browse https://gamertown.solutions (after the hosts entry)."
    if ($shape -eq 'fleet') { Write-Host "    Note: the bundle ships no CS2_GSLT, so CS2 boots tokenless (LAN-only) even here." -ForegroundColor DarkGray }
}

function Cmd-Dev([string[]]$rest) {
    $mode = ''; $shape = 'fleet'; $restoreForce = $false
    $pass = @()
    foreach ($a in $rest) {
        switch ($a) {
            '--fresh'     { $mode = 'fresh' }
            '--prod-like' { $mode = 'prodlike' }
            '--app'       { $shape = 'app' }
            '--restore'   { $restoreForce = $true }
            default       { $pass += $a }
        }
    }
    if ($mode -and $pass.Count -gt 0) { Write-Err2 "don't mix a mode flag with passthrough args ($($pass -join ' '))."; exit 1 }
    switch ($mode) {
        'fresh'    { Dev-Fresh $restoreForce }
        'prodlike' { Dev-ProdLike $shape }
        default {
            Require-DevFiles
            if ($pass.Count -eq 0) { $pass = @('up','-d','--build') }
            $code = Invoke-Compose 'dev-fresh' $pass
            exit $code
        }
    }
}

function Cmd-RestoreDb([string[]]$rest) {
    Update-EnvPath
    $vol = "$((Conf-Get 'project.dev')[0])_gt-data"
    $args2 = @('-Volume', $vol)
    if ($rest -and $rest.Count -gt 0) { $args2 += @('-Name', $rest[0]) }
    & (Join-Path $PSScriptRoot 'db-restore.ps1') @args2
    exit $LASTEXITCODE
}

function Usage {
    @"
gt - Gamertown dispatcher (Windows)

  .\tools\gt.ps1 dev --fresh            blank machine -> working dev stack (deps, secrets, DB, up)
  .\tools\gt.ps1 dev --prod-like        existing data, prod-shaped (real cert + gamertown.solutions)
  .\tools\gt.ps1 dev --prod-like --app  app only (no game servers)
  .\tools\gt.ps1 dev <compose args...>  passthrough: ps | logs -f app | down | up -d minecraft
  .\tools\gt.ps1 restore-db [name]      restore the app DB from R2 (newest, or a named snapshot)
  .\tools\gt.ps1 prod                   refused on Windows - prod runs on the keeper

Mode/env/compose mapping: tools/gt-modes.conf (shared with tools/gt.sh).
"@ | Write-Host
}

# ---- main ---------------------------------------------------------------------
$sub = if ($args.Count -gt 0) { $args[0] } else { '' }
$rest = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }

switch ($sub) {
    'dev'        { Cmd-Dev $rest }
    'restore-db' { Cmd-RestoreDb $rest }
    'prod' {
        Write-Err2 "'gt prod' runs ON THE KEEPER, not on Windows."
        Write-Host "  ssh root@192.168.1.241   then:   cd /root/gamertown && tools/gt.sh prod" -ForegroundColor Yellow
        exit 1
    }
    { $_ -in @('', 'help', '-h', '--help') } { Usage }
    default { Write-Err2 "unknown command: $sub"; Usage; exit 1 }
}
