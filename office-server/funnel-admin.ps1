# Put JPM HRMS on the internet with Tailscale Funnel (free, fixed https link).
# Run AFTER install-admin.ps1 works, in PowerShell opened with "Run as administrator":
#   powershell -ExecutionPolicy Bypass -File C:\JPM-HRMS-PY\funnel-admin.ps1
# It only ADDS a Funnel for port 8081 on a Funnel port nothing else uses (443, 8443 or 10000).
# Whatever Tailscale already shares (e.g. the HR portal) is never changed.
# To switch the HRMS link off again:  & 'C:\Program Files\Tailscale\tailscale.exe' funnel --https=<that port> off
$ErrorActionPreference = 'Stop'
. 'C:\JPM-HRMS-PY\scripts\common.ps1'
Assert-Admin

Write-Step '1. Checks'
if (-not (Test-Path $Tailscale)) { Write-Bad "Tailscale not found at $Tailscale"; exit 1 }
if ((Invoke-Program $Tailscale @('status')) -ne 0) { Write-Bad 'Tailscale is not connected on this PC. Open Tailscale and sign in, then run again.'; exit 1 }
$settingsText = Get-Content -Path $Settings -Raw
if ($settingsText -notmatch '(?m)^\s*APP_PASSWORD\s*=\s*\S{10,}') { Write-Bad 'Set APP_PASSWORD (10+ characters) in settings.env first; the app must have a login before it goes on the internet.'; exit 1 }
try { Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 15 | Out-Null; Write-Ok 'App is running on port 8081' }
catch { Write-Bad 'The app is not answering on port 8081. Run install-admin.ps1 first.'; exit 1 }

Write-Step '2. What does Tailscale already share? (kept exactly as it is)'
$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$current = (& $Tailscale serve status 2>&1 | Out-String)
$ErrorActionPreference = $old
Write-Host ('   ' + $current.Trim())
$url = Get-JpmFunnelUrl $current
if ($url) {
    Write-Ok "HRMS is already on the internet: $url"
} else {
    # Funnel can use only ports 443, 8443 and 10000. Take the first one nothing else uses.
    $used = @()
    foreach ($m in [regex]::Matches($current, '(?m)^\s*https://[A-Za-z0-9.-]+\.ts\.net(:(\d+))?\s*\(')) {
        if ($m.Groups[2].Success) { $used += [int]$m.Groups[2].Value } else { $used += 443 }
    }
    $port = @(443, 8443, 10000) | Where-Object { $used -notcontains $_ } | Select-Object -First 1
    if (-not $port) { Write-Bad 'All three Funnel ports (443, 8443, 10000) are already used. Nothing was changed. Send this output to Claude.'; exit 1 }
    if ($used.Count) { Write-Ok ("Ports in use: " + ($used -join ', ') + ". HRMS will use port $port; nothing else is changed.") }

    Write-Step "3. Turn on Funnel: port $port -> HRMS (8081)"
    Write-Host '   If it prints a login.tailscale.com link: open it, click Enable, and this window continues by itself.' -ForegroundColor Yellow
    $code = Invoke-Program $Tailscale @('funnel', '--bg', "--https=$port", 'http://127.0.0.1:8081')
    if ($code -ne 0) { Write-Bad 'Funnel could not be turned on (see the message above).'; exit 1 }
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $after = (& $Tailscale serve status 2>&1 | Out-String)
    $ErrorActionPreference = $old
    Write-Host ('   ' + $after.Trim())
    $url = Get-JpmFunnelUrl $after
    if (-not $url) { Write-Bad 'Funnel was set, but no link for port 8081 shows in "tailscale serve status".'; exit 1 }
}

Write-Step '4. Test the internet link'
try {
    $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 30
    Write-Ok ("Internet link answers: status=" + $health.status)
} catch { Write-Host ('   --  Could not test from this PC (' + $_.Exception.Message + '). Try the link on a mobile phone with Wi-Fi OFF.') -ForegroundColor Yellow }
Write-Host ''
Write-Host "HRMS internet link:  $url" -ForegroundColor Green
Write-Host 'Sign in with APP_USERNAME / APP_PASSWORD from settings.env.' -ForegroundColor Green
