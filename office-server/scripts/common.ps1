# Shared names and helpers for the JPM HRMS office scripts (Windows PowerShell 5.1).
$Root       = 'C:\JPM-HRMS-PY'
$Port       = 8081
$TaskApp    = 'JPM HRMS PY'
$TaskBackup = 'JPM HRMS PY Backup'
$RuleName   = 'JPM HRMS PY - port 8081 (office LAN only)'
$Python     = Join-Path $Root 'venv\Scripts\python.exe'
$Settings   = Join-Path $Root 'settings.env'
$HealthUrl  = "http://localhost:$Port/api/health"
$TaskBot    = 'JPM HRMS PY Bot'
$BotDir     = Join-Path $Root 'whatsapp-bot'
$Node       = 'C:\Program Files\nodejs\node.exe'
$Npm        = 'C:\Program Files\nodejs\npm.cmd'
$Tailscale  = 'C:\Program Files\Tailscale\tailscale.exe'

function Stop-JpmBot {
    Stop-ScheduledTask -TaskName $TaskBot -ErrorAction SilentlyContinue
    # Only the bot started as  node "C:\JPM-HRMS-PY\whatsapp-bot\bot.js"  (never another Node program).
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*JPM-HRMS-PY\whatsapp-bot\bot.js*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Write-Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text)   { Write-Host "   OK  $Text" -ForegroundColor Green }
function Write-Bad([string]$Text)  { Write-Host "   !!  $Text" -ForegroundColor Red }

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Bad 'Please run this in PowerShell opened with "Run as administrator".'
        exit 1
    }
}

# Runs a program (icacls, python, ...) without PowerShell turning its error output into a crash.
function Invoke-Program([string]$File, [string[]]$Arguments) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $File @Arguments 2>&1 | ForEach-Object { "   $_" } | Out-Host } finally { $ErrorActionPreference = $old }
    return $LASTEXITCODE
}

function Get-LanIp {
    $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Sort-Object InterfaceMetric | Select-Object -First 1
    if ($ip) { return $ip.IPAddress } else { return '<this PC IP>' }
}

function Stop-JpmApp {
    Stop-ScheduledTask -TaskName $TaskApp -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*JPM-HRMS-PY\scripts\serve.py*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# Waits up to 90 s for the app to answer; prints what it answered.
function Wait-JpmHealth {
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 15 -ErrorAction Stop
            Write-Ok ("App answered: status=" + $health.status + ", mongodb=" + $health.mongodb + ", records=" + $health.records)
            return $true
        } catch {
            Start-Sleep -Seconds 3
        }
    }
    Write-Bad "No answer from $HealthUrl after 90 seconds. Look in $Root\logs (app.log, console-*.log)."
    return $false
}
