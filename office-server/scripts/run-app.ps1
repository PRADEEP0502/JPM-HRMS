# JPM HRMS runner (Windows PowerShell 5.1). Started by the "JPM HRMS PY" scheduled task as SYSTEM.
# Keeps the app running: if it stops for any reason, it is started again after 15 seconds.
$ErrorActionPreference = 'Continue'
$Root = 'C:\JPM-HRMS-PY'
$Python = Join-Path $Root 'venv\Scripts\python.exe'
$Serve = Join-Path $Root 'scripts\serve.py'
$Logs = Join-Path $Root 'logs'
if (-not (Test-Path $Logs)) { New-Item -ItemType Directory -Path $Logs | Out-Null }

function Write-RunnerLog([string]$Text) {
    $file = Join-Path $Logs ('runner-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
    Add-Content -Path $file -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Text) -Encoding UTF8
}

while ($true) {
    # Remove log files older than 14 days (app.log rotates itself and keeps 14).
    Get-ChildItem -Path $Logs -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
        Remove-Item -Force -ErrorAction SilentlyContinue

    Write-RunnerLog 'Starting JPM HRMS'
    $console = Join-Path $Logs ('console-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
    # cmd.exe does the redirection so Python's error output (stderr) never stops this script.
    & cmd.exe /c ('"' + $Python + '" -u "' + $Serve + '" >> "' + $console + '" 2>&1')
    Write-RunnerLog ('JPM HRMS stopped (exit code ' + $LASTEXITCODE + '). Restarting in 15 seconds.')
    Start-Sleep -Seconds 15
}
