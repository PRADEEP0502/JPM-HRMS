# JPM HRMS - one-time setup. Run in PowerShell opened with "Run as administrator":
#   powershell -ExecutionPolicy Bypass -File C:\JPM-HRMS-PY\install-admin.ps1
# Safe to run again. It does NOT touch C:\JPM-HRMS, the "JPM HR Portal" tasks, port 8080 or Tailscale.
$ErrorActionPreference = 'Stop'
. 'C:\JPM-HRMS-PY\scripts\common.ps1'
Assert-Admin

Write-Step '0. Python and packages (private copy in C:\JPM-HRMS-PY\venv)'
if (-not (Test-Path $Python)) {
    # A Python installed "for all users" (in C:\Program Files) is best: the SYSTEM task can always use it.
    $base = $null
    foreach ($v in '311', '312') {
        $p = "C:\Program Files\Python$v\python.exe"
        if (Test-Path $p) { $base = $p; break }
    }
    if (-not $base) {
        Write-Bad 'Python 3.11 (for all users) is not installed on this PC.'
        Write-Host '   Install it once: python.org > Downloads > Windows > Python 3.11.9 "Windows installer (64-bit)".' -ForegroundColor Yellow
        Write-Host '   In the installer choose "Customize installation" > Next > tick "Install Python 3.11 for all users" > Install.' -ForegroundColor Yellow
        Write-Host '   Then run this script again.' -ForegroundColor Yellow
        exit 1
    }
    Write-Ok "Using $base"
    $code = Invoke-Program $base @('-m', 'venv', (Join-Path $Root 'venv'))
    if ($code -ne 0 -or -not (Test-Path $Python)) { Write-Bad 'Could not create the Python environment.'; exit 1 }
}
$code = Invoke-Program $Python @('-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', (Join-Path $Root 'app\requirements-office.txt'))
if ($code -ne 0) { Write-Bad 'Package install failed. Is this PC connected to the internet?'; exit 1 }
Write-Ok 'Python packages installed'

Write-Step '1. Check settings.env'
$lines = Get-Content -Path $Settings
if (-not ($lines | Where-Object { $_ -match '^\s*MONGO_URI\s*=\s*\S' })) {
    Write-Bad "MONGO_URI is empty. Open $Settings in Notepad, paste the MongoDB Atlas address, save, then run this again."
    exit 1
}
Write-Ok 'MONGO_URI is filled in'
if (-not ($lines | Where-Object { $_ -match '^\s*APP_USERNAME\s*=\s*\S' }) -or -not ($lines | Where-Object { $_ -match '^\s*APP_PASSWORD\s*=\s*\S{10,}' })) {
    Write-Bad 'APP_USERNAME and APP_PASSWORD (at least 10 characters) are needed: they are the login for the app.'
    exit 1
}
Write-Ok 'Login (APP_USERNAME / APP_PASSWORD) is filled in'
if ($lines | Where-Object { $_ -match '^\s*WA_BOT_TOKEN\s*=\s*\S' }) { Write-Ok 'WA_BOT_TOKEN is filled in' }
else { Write-Host '   --  WA_BOT_TOKEN is empty: the app works, but the WhatsApp bot cannot connect until it is set.' -ForegroundColor Yellow }

Write-Step '2. Lock the folder (only Administrators and SYSTEM can change it; settings.env private)'
$admins = '*S-1-5-32-544'; $system = '*S-1-5-18'; $users = '*S-1-5-32-545'
[void](Invoke-Program 'icacls.exe' @($Root, '/setowner', $admins, '/T', '/C', '/Q'))
[void](Invoke-Program 'icacls.exe' @($Root, '/inheritance:r', '/grant:r', "${admins}:(OI)(CI)F", "${system}:(OI)(CI)F", "${users}:(OI)(CI)RX"))
[void](Invoke-Program 'icacls.exe' @("$Root\*", '/reset', '/T', '/C', '/Q'))
[void](Invoke-Program 'icacls.exe' @($Settings, '/inheritance:r', '/grant:r', "${admins}:F", "${system}:F"))
$botConfig = Join-Path $Root 'whatsapp-bot\config.json'   # holds the bot token
if (Test-Path $botConfig) { [void](Invoke-Program 'icacls.exe' @($botConfig, '/inheritance:r', '/grant:r', "${admins}:F", "${system}:F")) }
Invoke-Program 'icacls.exe' @($Settings) | Out-Null

Write-Step '3. Office network -> Private (needed for the office-only firewall rule)'
# Only the connection(s) that have an office address (192.168.x.x / 10.x.x.x / 172.16-31.x.x) are changed.
$officeIfs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)' } | Select-Object -ExpandProperty InterfaceIndex -Unique
foreach ($net in (Get-NetConnectionProfile | Where-Object { $officeIfs -contains $_.InterfaceIndex })) {
    if ($net.NetworkCategory -eq 'Public') {
        Set-NetConnectionProfile -InterfaceIndex $net.InterfaceIndex -NetworkCategory Private
        Write-Ok ($net.InterfaceAlias + ' changed from Public to Private')
    } else { Write-Ok ($net.InterfaceAlias + ' is ' + $net.NetworkCategory) }
}

Write-Step '4. First backup of the database (before relying on anything)'
$code = Invoke-Program $Python @("$Root\scripts\backup.py")
if ($code -ne 0) { Write-Bad 'Backup failed, so setup stops here. Check MONGO_URI and the internet connection.'; exit 1 }

Write-Step '5. Firewall: one inbound rule, port 8081, office network only'
if (-not (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $RuleName -Description 'JPM HRMS office server. Office network only; no internet access.' `
        -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -Profile Private,Domain -Action Allow | Out-Null
    Write-Ok 'Rule added'
} else { Write-Ok 'Rule already exists' }
$rule = Get-NetFirewallRule -DisplayName $RuleName
$rule | Format-List DisplayName, Enabled, Direction, Action, Profile | Out-Host
$rule | Get-NetFirewallPortFilter | Format-List Protocol, LocalPort | Out-Host
$rule | Get-NetFirewallAddressFilter | Format-List RemoteAddress | Out-Host

Write-Step '6. Scheduled tasks (run as SYSTEM, also before anyone signs in)'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$appAction = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $Root `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Root\scripts\run-app.ps1`""
$appSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskApp -Action $appAction -Trigger (New-ScheduledTaskTrigger -AtStartup) `
    -Principal $principal -Settings $appSettings -Description 'JPM HRMS office server on port 8081 (C:\JPM-HRMS-PY).' -Force | Out-Null
Write-Ok "Task '$TaskApp' (at Windows start)"
$backupAction = New-ScheduledTaskAction -Execute $Python -Argument "`"$Root\scripts\backup.py`"" -WorkingDirectory $Root
$backupSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskBackup -Action $backupAction -Trigger (New-ScheduledTaskTrigger -Daily -At '01:30') `
    -Principal $principal -Settings $backupSettings -Description 'Daily JPM HRMS database backup, newest 14 kept.' -Force | Out-Null
Write-Ok "Task '$TaskBackup' (every day 01:30, or as soon as the PC is on)"

Write-Step '7. Start and test'
Stop-JpmApp
Start-ScheduledTask -TaskName $TaskApp
$ok = Wait-JpmHealth
try {
    $page = Invoke-WebRequest -Uri "http://localhost:$Port/" -UseBasicParsing -TimeoutSec 15
    $html = [string]$page.Content
    if ($html -match 'id="root"') { Write-Ok "Screens load (HTTP $($page.StatusCode))" } else { Write-Bad 'Home page did not look like the app' }
} catch { Write-Bad ('Home page failed: ' + $_.Exception.Message) }

Write-Host ''
if ($ok) {
    Write-Host ('Open from any office computer:  http://' + (Get-LanIp) + ":$Port") -ForegroundColor Green
} else {
    Write-Host 'Setup finished, but the app did not answer yet. Send me the last lines of C:\JPM-HRMS-PY\logs\app.log' -ForegroundColor Yellow
}
