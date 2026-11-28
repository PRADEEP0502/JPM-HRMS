# Restart JPM HRMS. Run in PowerShell opened with "Run as administrator":
#   powershell -ExecutionPolicy Bypass -File C:\JPM-HRMS-PY\restart.ps1
$ErrorActionPreference = 'Stop'
. 'C:\JPM-HRMS-PY\scripts\common.ps1'
Assert-Admin
Write-Step 'Restarting JPM HRMS'
Stop-JpmApp
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $TaskApp
[void](Wait-JpmHealth)
