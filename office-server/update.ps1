# Update JPM HRMS on the server PC with a new package.
# 1. Copy the new JPM-HRMS-PY-package-*.zip to this PC and extract it to C:\JPM-HRMS-PY-new
# 2. Run in PowerShell opened with "Run as administrator":
#      powershell -ExecutionPolicy Bypass -File C:\JPM-HRMS-PY\update.ps1
# Only the program files (app, scripts) are replaced. settings.env, logs and backups are kept.
param([string]$From = 'C:\JPM-HRMS-PY-new')
$ErrorActionPreference = 'Stop'
. 'C:\JPM-HRMS-PY\scripts\common.ps1'
Assert-Admin

Write-Step "1. Check the new package in $From"
foreach ($need in 'app\app.py', 'app\dist\index.html', 'scripts\serve.py') {
    if (-not (Test-Path (Join-Path $From $need))) { Write-Bad "$need is missing in $From. Extract the package there first."; exit 1 }
}
Write-Ok 'Package looks complete'

Write-Step '2. Install Python packages (if they changed)'
$code = Invoke-Program $Python @('-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', (Join-Path $From 'app\requirements-office.txt'))
if ($code -ne 0) { Write-Bad 'Package install failed; the running app was not changed.'; exit 1 }
Write-Ok 'Packages ready'

Write-Step '3. Swap in the new version (the previous one is kept as app.old / scripts.old)'
Stop-JpmApp
foreach ($part in 'app', 'scripts') {
    $current = Join-Path $Root $part
    $old = Join-Path $Root "$part.old"
    if (Test-Path $old) { Remove-Item -Path $old -Recurse -Force }   # the version before the previous one
    if (Test-Path $current) { Rename-Item -Path $current -NewName "$part.old" }
    Copy-Item -Path (Join-Path $From $part) -Destination $current -Recurse
}
foreach ($file in 'install-admin.ps1', 'install-bot-admin.ps1', 'funnel-admin.ps1', 'restart.ps1', 'update.ps1', 'status.ps1', 'README.txt', 'settings.template.env') {
    if (Test-Path (Join-Path $From $file)) { Copy-Item -Path (Join-Path $From $file) -Destination $Root -Force }
}
Write-Ok 'Files replaced'

Write-Step '4. Start and test'
Start-ScheduledTask -TaskName $TaskApp
[void](Wait-JpmHealth)

$newBot = Join-Path $From 'whatsapp-bot'
if ((Test-Path (Join-Path $newBot 'bot.js')) -and (Get-ScheduledTask -TaskName $TaskBot -ErrorAction SilentlyContinue)) {
    Write-Step '5. WhatsApp bot (config.json, auth and sent.json are kept)'
    Stop-JpmBot
    foreach ($file in 'bot.js', 'package.json', 'package-lock.json', 'README.md') {
        if (Test-Path (Join-Path $newBot $file)) { Copy-Item -Path (Join-Path $newBot $file) -Destination $BotDir -Force }
    }
    if (Test-Path (Join-Path $newBot 'node_modules')) {
        $modules = Join-Path $BotDir 'node_modules'
        if (Test-Path $modules) { Remove-Item -Path $modules -Recurse -Force }   # bot libraries, replaced by the new ones
        Copy-Item -Path (Join-Path $newBot 'node_modules') -Destination $modules -Recurse
    }
    Start-ScheduledTask -TaskName $TaskBot
    Write-Ok 'Bot updated and started'
}
Write-Host 'If something is wrong, tell Claude; the previous version is in app.old and scripts.old.' -ForegroundColor Yellow
