# Auto-start the AI Command Center at logon — NO admin required.
# Run once:  powershell -ExecutionPolicy Bypass -File install-startup.ps1
# Remove:    powershell -ExecutionPolicy Bypass -File install-startup.ps1 -Remove
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cmd  = Join-Path $here 'tray.cmd'   # tray controller; it starts the server + bot
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$name = 'AICommandCenter'

if ($Remove) {
  Remove-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue
  Write-Host "Removed auto-start entry '$name'."
  return
}

# HKCU Run key runs at logon for the current user — no admin, no scheduled task.
Set-ItemProperty -Path $runKey -Name $name -Value ('"{0}"' -f $cmd)
Write-Host "Registered auto-start (HKCU Run): server + bot will launch at every logon."
Write-Host "Starting it now..."
Start-Process -FilePath $cmd -WorkingDirectory $here
Write-Host "Done. Logs: server.log / bot.log in $here"
