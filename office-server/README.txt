JPM HRMS - server PC (office: http://<server IP>:8081, internet: Tailscale Funnel https link)
===========================================================================================

FROM GITHUB (no pendrive) - needs Git (git-scm.com), Node.js LTS and Python 3.11 "for all users"
 PowerShell "Run as administrator":
      git clone https://github.com/PRADEEP0502/JPM-HRMS.git C:\JPM-HRMS-SRC
      powershell -ExecutionPolicy Bypass -File C:\JPM-HRMS-SRC\office-server\get-from-github.ps1
 It installs to C:\JPM-HRMS-PY; then fill in settings.env and run install-admin.ps1 (below, step 4).
 To UPDATE later: run the get-from-github.ps1 line again (it pulls, rebuilds and restarts).

FIRST TIME on the server PC (zip way)
 1. Extract this zip so that this file is at  C:\JPM-HRMS-PY\README.txt
 2. Install (once, if not there yet):
    - Python 3.11.9 64-bit from python.org > Customize installation > tick "Install Python 3.11 for all users"
    - Node.js LTS from nodejs.org (default options)                       (for the WhatsApp bot)
 3. Notepad > C:\JPM-HRMS-PY\settings.env > fill in MONGO_URI, APP_USERNAME, APP_PASSWORD, WA_BOT_TOKEN > Save
    Notepad > C:\JPM-HRMS-PY\whatsapp-bot\config.json > "botToken": same text as WA_BOT_TOKEN > Save
 4. Right-click PowerShell > Run as administrator, then one by one:
      powershell -ExecutionPolicy Bypass -File C:\JPM-HRMS-PY\install-admin.ps1       (app, office network)
      powershell -ExecutionPolicy Bypass -File C:\JPM-HRMS-PY\funnel-admin.ps1        (internet link)
      powershell -ExecutionPolicy Bypass -File C:\JPM-HRMS-PY\install-bot-admin.ps1   (WhatsApp bot, QR scan)

EVERY DAY
 Is it running?   powershell -ExecutionPolicy Bypass -File C:\JPM-HRMS-PY\status.ps1
 Restart (admin)  powershell -ExecutionPolicy Bypass -File C:\JPM-HRMS-PY\restart.ps1
 Logs             C:\JPM-HRMS-PY\logs        (app.log, bot-*.log, backup.log; 14 days kept)
 Backups          C:\JPM-HRMS-PY\backups     (daily 01:30, newest 14 kept)
 Settings         Notepad "Run as administrator" > settings.env > then restart.ps1
 Internet off     & 'C:\Program Files\Tailscale\tailscale.exe' funnel --https=443 off

UPDATE (new package from the laptop)
 On the laptop:  powershell -ExecutionPolicy Bypass -File C:\HRAT\office-server\build-package.ps1
                 (makes JPM-HRMS-PY-package-<date>.zip on the Desktop)
 On the server:  extract the new zip to C:\JPM-HRMS-PY-new, then (admin):
      powershell -ExecutionPolicy Bypass -File C:\JPM-HRMS-PY\update.ps1
