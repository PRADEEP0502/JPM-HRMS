# Put JPM HRMS on the internet with Tailscale Funnel (free, fixed https link).
# Run AFTER install-admin.ps1 works, in PowerShell opened with "Run as administrator":
#   powershell -ExecutionPolicy Bypass -File C:\JPM-HRMS-PY\funnel-admin.ps1
# It only ADDS a Funnel for port 8081. It stops without changing anything if Tailscale already
# shares something (so the HR portal or other Tailscale settings are never replaced).
# To switch the internet link off again:  & 'C:\Program Files\Tailscale\tailscale.exe' funnel --https=443 off
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

Write-Step '2. Is Tailscale already sharing something?'
$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$current = (& $Tailscale serve status 2>&1 | Out-String)
$ErrorActionPreference = $old
Write-Host ('   ' + $current.Trim())
if ($current -notmatch 'No serve config' -and $current -notmatch '127\.0\.0\.1:8081') {
    Write-Bad 'Tailscale already shares something on this PC. Nothing was changed. Send this output to Claude.'
    exit 1
}

Write-Step '3. Turn on Funnel for port 8081'
Write-Host '   If it prints a login.tailscale.com link: open it, click Enable, and this window continues by itself.' -ForegroundColor Yellow
$code = Invoke-Program $Tailscale @('funnel', '--bg', 'http://127.0.0.1:8081')
if ($code -ne 0) { Write-Bad 'Funnel could not be turned on (see the message above).'; exit 1 }
Invoke-Program $Tailscale @('funnel', 'status') | Out-Null

Write-Step '4. Test the internet link'
$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$statusText = (& $Tailscale funnel status 2>&1 | Out-String)
$ErrorActionPreference = $old
$url = ([regex]::Match($statusText, 'https://[A-Za-z0-9.-]+\.ts\.net')).Value
if ($url) {
    try {
        $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 30
        Write-Ok ("Internet link answers: status=" + $health.status)
    } catch { Write-Host ('   --  Could not test from this PC (' + $_.Exception.Message + '). Try the link on a mobile phone with Wi-Fi OFF.') -ForegroundColor Yellow }
    Write-Host ''
    Write-Host "Internet link for everyone:  $url" -ForegroundColor Green
    Write-Host 'Sign in with APP_USERNAME / APP_PASSWORD from settings.env.' -ForegroundColor Green
} else { Write-Bad 'No https link found in "tailscale funnel status".' }
