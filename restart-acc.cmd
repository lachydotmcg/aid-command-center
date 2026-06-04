@echo off
REM Double-click to restart the AI Command Center (kills old node, relaunches).
cd /d "%~dp0"
echo Stopping old server + bot + ngrok...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'server\.js|discord-bot\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Get-Process -Name ngrok -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Get-Process -Name cmd -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'ACC Server|ACC Discord Bot|ngrok' } | ForEach-Object { $_.Kill() }"
timeout /t 2 /nobreak >nul
echo Starting fresh...
call "%~dp0start.bat"
