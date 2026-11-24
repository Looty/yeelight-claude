<#
.SYNOPSIS
  Registers (or removes) the "Yeelight Daylight" scheduled task: runs `node daylight.js tick` every 10 minutes
  for the current user, with no console window.

.EXAMPLE
  .\install-daylight.ps1            # register / update the task
  .\install-daylight.ps1 -DryRun    # show what would be registered, change nothing
  .\install-daylight.ps1 -Uninstall # remove the task

  To pause without uninstalling, create an empty file named DAYLIGHT_OFF next to daylight.js.
  No admin rights needed. Nothing else (firewall, settings, the bulb) is touched.
#>
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$TaskName = 'Yeelight Daylight'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    if ($DryRun) { Write-Host "Would remove task '$TaskName'."; return }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed task '$TaskName'."
  } else {
    Write-Host "Task '$TaskName' is not registered."
  }
  return
}

$dir = $PSScriptRoot
$script = Join-Path $dir 'daylight.js'
if (-not (Test-Path -LiteralPath $script)) { throw "daylight.js not found next to this script ($dir)." }
$node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) { throw 'node.exe not found on PATH.' }

# daylight.js follows the sun at location.lat/lon from config.json; without it every tick does nothing.
$location = $null
try { $location = (Get-Content -LiteralPath (Join-Path $dir 'config.json') -Raw | ConvertFrom-Json).location } catch {}
if (-not $location -or $null -eq $location.lat -or $null -eq $location.lon) {
  throw 'Set location.lat and location.lon in config.json first (see config.example.json).'
}

# node.exe is a console program, so a plain task would flash a window every 10 minutes.
# conhost --headless runs it without creating any window (Windows 10 1809+ / Windows 11).
$conhost = Join-Path $env:WINDIR 'System32\conhost.exe'
$arguments = "--headless `"$node`" `"$script`" tick"

$action = New-ScheduledTaskAction -Execute $conhost -Argument $arguments -WorkingDirectory $dir
# No -RepetitionDuration: on Windows 10/11 the repetition then runs indefinitely.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive -RunLevel Limited

if ($DryRun) {
  Write-Host "Task:     $TaskName (every 10 min, current user, not elevated)"
  Write-Host "Command:  $conhost $arguments"
  Write-Host "Work dir: $dir"
  return
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Glides the color bulb through a daylight color-temperature curve (daylight.js). Never turns it on or off.' `
  -Force | Out-Null
Write-Host "Registered '$TaskName': every 10 minutes, first run in about a minute."
Write-Host "Check it with: node `"$script`" status    Remove it with: .\install-daylight.ps1 -Uninstall"
