@echo off
REM Double-click to restart the AI Command Center (kills old node, relaunches).
cd /d "%~dp0"
echo Stopping old server + bot...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'server\.js|discord-bot\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 2 /nobreak >nul
echo Starting fresh...
call "%~dp0start.bat"
