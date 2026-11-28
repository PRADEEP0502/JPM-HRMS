# JPM HRMS WhatsApp bot runner (Windows PowerShell 5.1). Started by the "JPM HRMS PY Bot" task as SYSTEM.
# If the bot stops for any reason, it is started again after 15 seconds.
$ErrorActionPreference = 'Continue'
$Root = 'C:\JPM-HRMS-PY'
$Node = 'C:\Program Files\nodejs\node.exe'
$Bot = Join-Path $Root 'whatsapp-bot\bot.js'
$Logs = Join-Path $Root 'logs'
if (-not (Test-Path $Logs)) { New-Item -ItemType Directory -Path $Logs | Out-Null }
Set-Location (Join-Path $Root 'whatsapp-bot')

function Write-RunnerLog([string]$Text) {
    $file = Join-Path $Logs ('bot-runner-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
    Add-Content -Path $file -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Text) -Encoding UTF8
}

while ($true) {
    Get-ChildItem -Path $Logs -File -Filter 'bot-*' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
    Write-RunnerLog 'Starting WhatsApp bot'
    $console = Join-Path $Logs ('bot-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
    & cmd.exe /c ('"' + $Node + '" "' + $Bot + '" >> "' + $console + '" 2>&1')
    Write-RunnerLog ('WhatsApp bot stopped (exit code ' + $LASTEXITCODE + '). Restarting in 15 seconds.')
    Start-Sleep -Seconds 15
}
