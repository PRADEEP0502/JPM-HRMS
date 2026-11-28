# WhatsApp bot on the server PC. Run AFTER install-admin.ps1 works, in PowerShell "Run as administrator":
#   powershell -ExecutionPolicy Bypass -File C:\JPM-HRMS-PY\install-bot-admin.ps1
# Needs Node.js LTS installed (nodejs.org, default options). First time it opens a window with a QR code.
$ErrorActionPreference = 'Stop'
. 'C:\JPM-HRMS-PY\scripts\common.ps1'
Assert-Admin

Write-Step '1. Node.js'
if (-not (Test-Path $Node)) {
    Write-Bad 'Node.js is not installed. Install the LTS version from nodejs.org (default options), then run again.'
    exit 1
}
$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$version = (& $Node --version 2>&1 | Out-String).Trim()
$ErrorActionPreference = $old
Write-Ok "Node $version"

Write-Step '2. Bot settings (config.json)'
$configFile = Join-Path $BotDir 'config.json'
$config = Get-Content -Path $configFile -Raw | ConvertFrom-Json
$tokenLine = (Get-Content -Path $Settings | Where-Object { $_ -match '^\s*WA_BOT_TOKEN\s*=' } | Select-Object -First 1)
$serverToken = ''
if ($tokenLine) { $serverToken = ($tokenLine -replace '^\s*WA_BOT_TOKEN\s*=\s*', '').Trim().Trim('"').Trim("'") }
if (-not $config.botToken) { Write-Bad "botToken is empty in $configFile. Paste the same text as WA_BOT_TOKEN in settings.env."; exit 1 }
if ($serverToken.Length -lt 20) { Write-Bad 'WA_BOT_TOKEN in settings.env is empty or shorter than 20 characters.'; exit 1 }
if ($config.botToken -ne $serverToken) { Write-Bad 'botToken in config.json is not the same as WA_BOT_TOKEN in settings.env.'; exit 1 }
Write-Ok ('Token matches; bot talks to ' + $config.apiUrl)
# config.json holds the token: only Administrators and SYSTEM may read it.
[void](Invoke-Program 'icacls.exe' @($configFile, '/inheritance:r', '/grant:r', '*S-1-5-32-544:F', '*S-1-5-18:F'))

Write-Step '3. Bot packages (they come inside the package zip)'
if (-not (Test-Path (Join-Path $BotDir 'node_modules\@whiskeysockets\baileys\package.json'))) {
    Write-Bad 'whatsapp-bot\node_modules is missing. Extract the full package zip again.'
    exit 1
}
Write-Ok 'Packages present'

Write-Step '4. Link WhatsApp (only the first time)'
$creds = Join-Path $BotDir 'auth\creds.json'
$linked = (Test-Path $creds) -and ((Get-Content -Path $creds -Raw) -match '"me"\s*:')
if (-not $linked) {
    Stop-JpmBot
    Write-Host '   A new window opens with a QR code. On the phone of the WhatsApp number that is in the group:' -ForegroundColor Yellow
    Write-Host '   WhatsApp > Linked devices > Link a device > scan the QR code. This window waits (10 minutes max).' -ForegroundColor Yellow
    Start-Process -FilePath $Node -ArgumentList ('"' + (Join-Path $BotDir 'bot.js') + '"') -WorkingDirectory $BotDir
    for ($i = 0; $i -lt 200 -and -not $linked; $i++) {
        Start-Sleep -Seconds 3
        $linked = (Test-Path $creds) -and ((Get-Content -Path $creds -Raw -ErrorAction SilentlyContinue) -match '"me"\s*:')
    }
    Start-Sleep -Seconds 10   # let WhatsApp finish saving the link
    Stop-JpmBot
    if (-not $linked) { Write-Bad 'WhatsApp was not linked in 10 minutes. Run this script again.'; exit 1 }
    Write-Ok 'WhatsApp linked'
} else { Write-Ok 'WhatsApp already linked' }

Write-Step '5. Start the bot by itself at Windows start (task as SYSTEM)'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $BotDir `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Root\scripts\run-bot.ps1`""
$botSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskBot -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) `
    -Principal $principal -Settings $botSettings -Description 'JPM HRMS WhatsApp bot (C:\JPM-HRMS-PY\whatsapp-bot).' -Force | Out-Null
Stop-JpmBot
Start-ScheduledTask -TaskName $TaskBot
Write-Ok "Task '$TaskBot' started"

Write-Step '6. Check (30 seconds)'
Start-Sleep -Seconds 30
$log = Join-Path $Root ('logs\bot-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
Get-Content -Path $log -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { "   $_" }
Write-Host ''
Write-Host 'Look for "WhatsApp connected." above. The app Settings > WhatsApp alerts page also shows "Bot online".' -ForegroundColor Green
