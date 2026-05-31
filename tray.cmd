@echo off
REM Launches the AI Command Center tray controller (hidden). Double-click this,
REM or let it auto-run at logon via install-startup.ps1.
cd /d "%~dp0"
start "" powershell -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0tray.ps1"
