# Is JPM HRMS running? (no administrator needed)
#   powershell -ExecutionPolicy Bypass -File C:\JPM-HRMS-PY\status.ps1
$ErrorActionPreference = 'Continue'
. 'C:\JPM-HRMS-PY\scripts\common.ps1'

Write-Step 'Scheduled tasks'
foreach ($name in @($TaskApp, $TaskBot, $TaskBackup)) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($task) {
        $info = $task | Get-ScheduledTaskInfo
        Write-Host ("   {0,-20} state={1,-8} last run={2}  result={3}" -f $name, $task.State, $info.LastRunTime, $info.LastTaskResult)
    } else { Write-Bad "$name : not found" }
}

Write-Step 'App answer'
try {
    $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 15 -ErrorAction Stop
    Write-Ok ("status=" + $health.status + ", mongodb=" + $health.mongodb + ", records=" + $health.records)
    Write-Host ('   Office address: http://' + (Get-LanIp) + ":$Port") -ForegroundColor Green
} catch { Write-Bad ('No answer from ' + $HealthUrl + ' : ' + $_.Exception.Message) }

Write-Step 'Internet link (Tailscale Funnel)'
if (Test-Path $Tailscale) {
    $funnel = (& $Tailscale funnel status 2>&1 | Out-String)
    $url = ([regex]::Match($funnel, 'https://[A-Za-z0-9.-]+\.ts\.net')).Value
    if ($url -and $funnel -match '8081') { Write-Ok $url } else { Write-Bad 'Funnel is not on for port 8081' }
} else { Write-Bad 'Tailscale not installed' }

Write-Step 'Last 5 lines of the WhatsApp bot log'
Get-Content -Path (Join-Path $Root ('logs\bot-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')) -Tail 5 -ErrorAction SilentlyContinue | ForEach-Object { "   $_" }

Write-Step 'Last backup'
$last = Get-ChildItem -Path (Join-Path $Root 'backups') -Filter 'jpm_hrms_*.zip' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
if ($last) { Write-Host ('   ' + $last.Name + '  (' + [int]($last.Length / 1KB) + ' KB)') } else { Write-Bad 'no backup yet' }

Write-Step 'Last 10 lines of logs\app.log'
Get-Content -Path (Join-Path $Root 'logs\app.log') -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { "   $_" }
