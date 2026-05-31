@echo off
REM ── AI Command Center launcher ──────────────────────────────────────────────
REM Starts the server and the Discord bot, each in its own minimized window so
REM they keep running. Logs go to server.log / bot.log in this folder.
cd /d "%~dp0"

start "ACC Server" /min cmd /c "node --env-file-if-exists=.env server.js >> server.log 2>&1"
start "ACC Discord Bot" /min cmd /c "node --env-file-if-exists=.env discord-bot.js >> bot.log 2>&1"

echo AI Command Center started (server + discord bot). Logs: server.log / bot.log
