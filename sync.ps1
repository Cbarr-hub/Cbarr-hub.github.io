# sync.ps1 — commit, pull, fix conflicts with Claude, push
$env:GIT_MERGE_AUTOEDIT = 'no'

Write-Host "`n==> Staging all changes..." -ForegroundColor Cyan
git add -A

$dirty = git status --porcelain
if ($dirty) {
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
    git commit -m "chore: save work $timestamp"
    Write-Host "==> Committed." -ForegroundColor Green
} else {
    Write-Host "==> Nothing to commit." -ForegroundColor Yellow
}

Write-Host "`n==> Pulling from origin/main..." -ForegroundColor Cyan
git pull --no-edit origin main

$conflicts = git diff --name-only --diff-filter=U 2>$null
if ($conflicts) {
    Write-Host "`n==> Merge conflicts detected:" -ForegroundColor Red
    $conflicts | ForEach-Object { Write-Host "      $_" -ForegroundColor Red }

    Write-Host "`n==> Opening VSCode and launching Claude to fix conflicts..." -ForegroundColor Cyan
    code .
    claude "There are merge conflicts in this repository. Please resolve all of them, preserving both sets of changes where logical, then stage the resolved files."

    $stillConflicts = git diff --name-only --diff-filter=U 2>$null
    if ($stillConflicts) {
        Write-Host "`n==> Conflicts still present. Fix them manually, then re-run this script." -ForegroundColor Red
        exit 1
    }

    git add -A
    git commit -m "chore: resolve merge conflicts"
    Write-Host "==> Merge conflicts resolved and committed." -ForegroundColor Green
}

Write-Host "`n==> Pushing to origin/main..." -ForegroundColor Cyan
git push origin main

Write-Host "`n==> Done.`n" -ForegroundColor Green
