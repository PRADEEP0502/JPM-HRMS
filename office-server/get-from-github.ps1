# SERVER PC: get the newest JPM HRMS code from GitHub and install or update it in C:\JPM-HRMS-PY.
# (The WhatsApp bot is not included here; it is set up separately.)
#
# First time (PowerShell "Run as administrator"):
#   git clone https://github.com/PRADEEP0502/JPM-HRMS.git C:\JPM-HRMS-SRC
#   powershell -ExecutionPolicy Bypass -File C:\JPM-HRMS-SRC\office-server\get-from-github.ps1
# Every update after that: run only the second line again.
# A "Download ZIP" copy from GitHub also works (run this file from inside it); it is then
# not updated from GitHub automatically: for an update, download the ZIP again and run it from there.
$ErrorActionPreference = 'Stop'
$Src    = Split-Path -Parent $PSScriptRoot          # the GitHub copy (git clone or ZIP download)
$Root   = 'C:\JPM-HRMS-PY'                          # where the app runs
$Stage  = 'C:\JPM-HRMS-PY-new'                      # new version is prepared here first
$Git    = 'C:\Program Files\Git\cmd\git.exe'
$NodeJs = 'C:\Program Files\nodejs'

function Write-Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text)   { Write-Host "   OK  $Text" -ForegroundColor Green }
function Write-Bad([string]$Text)  { Write-Host "   !!  $Text" -ForegroundColor Red }
function Invoke-Program([string]$File, [string[]]$Arguments) {
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & $File @Arguments 2>&1 | ForEach-Object { "   $_" } | Out-Host } finally { $ErrorActionPreference = $old }
    return $LASTEXITCODE
}

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Bad 'Please run this in PowerShell opened with "Run as administrator".'; exit 1
}

$isClone = Test-Path (Join-Path $Src '.git')

Write-Step '1. Tools'
if ($isClone -and -not (Test-Path $Git)) { Write-Bad 'Git is not installed. Install it from git-scm.com (default options), then run again.'; exit 1 }
if (-not (Test-Path (Join-Path $NodeJs 'node.exe'))) { Write-Bad 'Node.js is not installed. Install the LTS version from nodejs.org (default options), then run again.'; exit 1 }
$env:Path = "$NodeJs;" + $env:Path
Write-Ok 'Node.js found'

if ($isClone) {
    Write-Step "2. Get the newest code from GitHub into $Src"
    if ((Invoke-Program $Git @('-C', $Src, 'pull', '--ff-only')) -ne 0) {
        Write-Bad 'git pull failed (no internet, or GitHub sign-in needed). Nothing was changed.'; exit 1
    }
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $commit = (& $Git -C $Src log -1 --format='%h %s' 2>&1 | Out-String).Trim()
    $ErrorActionPreference = $old
    Write-Ok "Code version: $commit"
} else {
    Write-Step "2. Using the downloaded copy in $Src"
    Write-Ok 'ZIP download (no git): the code is used as it is'
}

Write-Step '3. Build the screens (first time takes a few minutes)'
$code = Invoke-Program 'cmd.exe' @('/c', "cd /d `"$Src`" && npm ci --no-audit --no-fund")
if ($code -ne 0) { Write-Bad 'npm ci failed. Nothing was changed.'; exit 1 }
if (Test-Path $Stage) { Remove-Item -Path $Stage -Recurse -Force }   # leftover from an earlier run of this script
New-Item -ItemType Directory -Path (Join-Path $Stage 'app') -Force | Out-Null
$code = Invoke-Program 'cmd.exe' @('/c', "cd /d `"$Src`" && set `"VITE_API_URL=`" && npx vite build --outDir `"$Stage\app\dist`" --emptyOutDir")
if ($code -ne 0 -or -not (Test-Path "$Stage\app\dist\index.html")) { Write-Bad 'Screen build failed. Nothing was changed. If it says "out of memory", close other programs and run again.'; exit 1 }
if (Select-String -Path "$Stage\app\dist\assets\*.js" -Pattern 'onrender.com' -Quiet) { Write-Bad 'Built screens still point to Render. Nothing was changed.'; exit 1 }
Write-Ok 'Screens built'

Write-Step "4. Prepare the new version in $Stage"
Copy-Item "$Src\app.py", "$Src\employee_master.json", "$PSScriptRoot\requirements-office.txt" -Destination "$Stage\app"
New-Item -ItemType Directory -Path "$Stage\scripts" | Out-Null
Copy-Item "$PSScriptRoot\scripts\*" -Include '*.py', '*.ps1' -Destination "$Stage\scripts"
foreach ($file in 'install-admin.ps1', 'install-bot-admin.ps1', 'funnel-admin.ps1', 'restart.ps1', 'update.ps1', 'status.ps1', 'README.txt', 'settings.template.env') {
    Copy-Item "$PSScriptRoot\$file" -Destination $Stage
}
Write-Ok 'Ready'

if (Get-ScheduledTask -TaskName 'JPM HRMS PY' -ErrorAction SilentlyContinue) {
    Write-Step '5. Update the running app'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$Root\update.ps1" -From $Stage
} else {
    Write-Step "5. First install: copy to $Root (settings.env, logs and backups there are kept)"
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
    Copy-Item -Path "$Stage\*" -Destination $Root -Recurse -Force
    if (-not (Test-Path "$Root\settings.env")) {
        Copy-Item "$Root\settings.template.env" -Destination "$Root\settings.env"   # empty values: you fill them in
    }
    Write-Ok "Installed to $Root"
    Write-Host ''
    Write-Host "Next: Notepad > $Root\settings.env > fill MONGO_URI, APP_USERNAME, APP_PASSWORD (WA_BOT_TOKEN later) > Save" -ForegroundColor Green
    Write-Host "Then: powershell -ExecutionPolicy Bypass -File $Root\install-admin.ps1" -ForegroundColor Green
}
