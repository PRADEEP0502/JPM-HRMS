# LAPTOP ONLY: makes the zip to copy to the server PC (no administrator needed).
#   powershell -ExecutionPolicy Bypass -File C:\HRAT\office-server\build-package.ps1
# Builds the screens from the repo and packs app + these office-server scripts.
# Never packs settings, logs, backups or a Python environment. The zip lands on the Desktop.
param([string]$Source = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot   # this office-server folder
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$stage = Join-Path $env:TEMP "JPM-HRMS-PY-package-$stamp"
$zip = Join-Path ([Environment]::GetFolderPath('Desktop')) "JPM-HRMS-PY-package-$stamp.zip"

New-Item -ItemType Directory -Path (Join-Path $stage 'app') -Force | Out-Null
Write-Host 'Building screens...'
$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& cmd.exe /c ('cd /d "' + $Source + '" && set "VITE_API_URL=" && npx vite build --outDir "' + (Join-Path $stage 'app\dist') + '" --emptyOutDir > "' + (Join-Path $env:TEMP 'jpm-build.log') + '" 2>&1')
$code = $LASTEXITCODE; $ErrorActionPreference = $old
if ($code -ne 0 -or -not (Test-Path (Join-Path $stage 'app\dist\index.html'))) { throw "Screen build failed, see $env:TEMP\jpm-build.log" }
if (Select-String -Path (Join-Path $stage 'app\dist\assets\*.js') -Pattern 'onrender.com' -Quiet) { throw 'Built screens still point to Render' }

Copy-Item (Join-Path $Source 'app.py'), (Join-Path $Source 'employee_master.json') -Destination (Join-Path $stage 'app')
Copy-Item (Join-Path $Root 'requirements-office.txt') -Destination (Join-Path $stage 'app')
New-Item -ItemType Directory -Path (Join-Path $stage 'scripts') | Out-Null
Copy-Item (Join-Path $Root 'scripts\*') -Include '*.py', '*.ps1' -Destination (Join-Path $stage 'scripts')
foreach ($file in 'install-admin.ps1', 'install-bot-admin.ps1', 'funnel-admin.ps1', 'restart.ps1', 'update.ps1', 'status.ps1', 'README.txt', 'settings.template.env') {
    Copy-Item (Join-Path $Root $file) -Destination $stage
}
Copy-Item (Join-Path $Root 'settings.template.env') -Destination (Join-Path $stage 'settings.env')   # empty values only

# WhatsApp bot: program files + its libraries (one comes from GitHub over SSH, which the server cannot
# download). Never its token, WhatsApp login (auth) or sent list.
$botStage = Join-Path $stage 'whatsapp-bot'
New-Item -ItemType Directory -Path $botStage | Out-Null
foreach ($file in 'bot.js', 'package.json', 'package-lock.json', 'README.md') {
    Copy-Item (Join-Path $Source "whatsapp-bot\$file") -Destination $botStage
}
Copy-Item (Join-Path $Source 'whatsapp-bot\node_modules') -Destination (Join-Path $botStage 'node_modules') -Recurse
'{' + "`r`n" + '  "apiUrl": "http://localhost:8081",' + "`r`n" + '  "botToken": ""' + "`r`n" + '}' | Set-Content -Path (Join-Path $botStage 'config.json') -Encoding ASCII

Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Remove-Item -Path $stage -Recurse -Force   # temporary copy made by this script
Write-Host "Package ready: $zip" -ForegroundColor Green
