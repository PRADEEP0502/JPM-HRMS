@echo off
rem Double-click to start the JPM WhatsApp bot. Put a shortcut to this file in
rem shell:startup so it starts again whenever the office PC restarts.
cd /d "%~dp0"
if not exist node_modules call npm install
:loop
node bot.js
echo Bot stopped. Restarting in 10 seconds...
timeout /t 10 /nobreak >nul
goto loop
