# AI Command Center — system tray controller.
# Sits in the notification tray with Start / Restart / Stop / logs.
# Launch hidden via tray.cmd. Auto-starts the server + bot on load.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Single-instance lock — stops duplicate trays (which caused multiple servers).
$global:accMutex = New-Object System.Threading.Mutex($false, 'Global\AICommandCenterTray')
if (-not $global:accMutex.WaitOne(0)) { exit }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Test-AccRunning {
  [bool](Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'server\.js|discord-bot\.js' })
}
function Stop-Acc {
  # Kill node processes (server + bot)
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'server\.js|discord-bot\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  # Kill ngrok
  Get-Process -Name ngrok -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  # Close the cmd windows we opened (by title) — prevents duplicates on restart
  Get-Process -Name cmd -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -match 'ACC Server|ACC Discord Bot|ngrok' } |
    ForEach-Object { $_.Kill() }
}
function Start-Acc {
  # Use start.bat — the proven launcher (server + bot + opens the dashboard).
  Start-Process -FilePath (Join-Path $here 'start.bat') -WorkingDirectory $here
}

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = [System.Drawing.SystemIcons]::Application
$ni.Text = 'AI Command Center'
$ni.Visible = $true

function Notify($title, $msg) {
  $ni.BalloonTipTitle = $title; $ni.BalloonTipText = $msg; $ni.ShowBalloonTip(2500)
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$mStart = $menu.Items.Add('Start')
$mRestart = $menu.Items.Add('Restart')
$mStop = $menu.Items.Add('Stop')
$menu.Items.Add('-') | Out-Null
$mStatus = $menu.Items.Add('Status')
$mServerLog = $menu.Items.Add('Open server log')
$mBotLog = $menu.Items.Add('Open bot log')
$menu.Items.Add('-') | Out-Null
$mExit = $menu.Items.Add('Exit (stops nothing)')

$mStart.Add_Click({ if (Test-AccRunning) { Notify 'AI Command Center' 'Already running.' } else { Start-Acc; Notify 'AI Command Center' 'Started server + bot.' } })
$mRestart.Add_Click({ Stop-Acc; Start-Sleep -Milliseconds 600; Start-Acc; Notify 'AI Command Center' 'Restarted server + bot.' })
$mStop.Add_Click({ Stop-Acc; Notify 'AI Command Center' 'Stopped server + bot.' })
$mStatus.Add_Click({ if (Test-AccRunning) { Notify 'AI Command Center' 'Running ✅' } else { Notify 'AI Command Center' 'Not running ❌' } })
$mServerLog.Add_Click({ Start-Process (Join-Path $here 'server.log') })
$mBotLog.Add_Click({ Start-Process (Join-Path $here 'bot.log') })
$mExit.Add_Click({ $ni.Visible = $false; $ni.Dispose(); [System.Windows.Forms.Application]::Exit() })

$ni.ContextMenuStrip = $menu
$ni.Add_MouseDoubleClick({ if (Test-AccRunning) { Notify 'AI Command Center' 'Running ✅' } else { Notify 'AI Command Center' 'Not running ❌ — use Start' } })

# Auto-start on launch.
if (-not (Test-AccRunning)) { Start-Acc; Notify 'AI Command Center' 'Started. Right-click the tray icon to control.' }
else { Notify 'AI Command Center' 'Already running. Right-click the tray icon to control.' }

[System.Windows.Forms.Application]::Run()
