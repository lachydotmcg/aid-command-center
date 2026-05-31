@echo off
echo Starting AI Command Center...
cd /d "%~dp0"

start "ACC Server" cmd /k "node --env-file-if-exists=.env server.js"

if exist .env (
    start "ACC Discord Bot" cmd /k "node --env-file-if-exists=.env discord-bot.js"
) else (
    echo [Discord bot skipped - no .env file found. Create one with DISCORD_TOKEN=your_token]
)

timeout /t 2 /nobreak >nul
start "" "http://localhost:3333"
