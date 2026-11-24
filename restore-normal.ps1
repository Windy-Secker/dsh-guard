# restore-normal.ps1 - bring dsh back to a normal, manually-started session.
#
# Use this if a restart test left you without a GUI: it stops the guard's
# watchdog (so nothing fights you for the port), then starts dsh the ordinary way
# - in its own visible console window - and waits for it to answer.
#
# It does NOT touch the plugin or the profile patch; the guard stays installed and
# simply spawns a fresh watchdog on the next boot.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File restore-normal.ps1
#   powershell -ExecutionPolicy Bypass -File restore-normal.ps1 -Port 3080 -WaitSeconds 90
param(
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
    [string]$DshEntry = 'E:\dsh\app\dsh\lib\bin.js',
    [int]$Port = 3080,
    [int]$WaitSeconds = 90
)

$ErrorActionPreference = 'Continue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$guardDir = Join-Path $DshHome 'guard'

function Test-Port([int]$Value) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $task = $client.ConnectAsync('127.0.0.1', $Value)
        $done = $task.Wait(1200)
        $client.Close()
        return $done -and $task.Status -eq 'RanToCompletion'
    } catch {
        return $false
    }
}

Write-Output "dsh home : $DshHome"
Write-Output "dsh entry: $DshEntry"

if (-not (Test-Path $DshEntry)) {
    Write-Output "REFUSING: dsh entry not found at $DshEntry (pass -DshEntry <path to lib/bin.js>)"
    exit 2
}

# 1. If something already answers on the port, this script has nothing to do —
#    and in particular must NOT stop the running watchdog. (An earlier version
#    stopped the watchdog before checking the port, so a harmless "is dsh up?"
#    probe also disarmed the guard.)
if (Test-Port $Port) {
    Write-Output "something already answers on 127.0.0.1:$Port - open the GUI instead of starting a second dsh"
    Write-Output 'this script did not touch the watchdog'
    exit 0
}

# 2. Stop the guard's watchdog(s) for this state directory, so a queued restart
#    cannot race the manual one. Match on the command line, not just the name.
$stopped = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    $cmd = [string]$_.CommandLine
    if ($cmd -match 'watchdog\.mjs' -and $cmd -match [regex]::Escape($guardDir)) {
        try {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
            Write-Output "stopped watchdog pid $($_.ProcessId)"
            $stopped += 1
        } catch {
            Write-Output "could not stop watchdog pid $($_.ProcessId): $($_.Exception.Message)"
        }
    }
}
if ($stopped -eq 0) { Write-Output 'no guard watchdog was running' }
Remove-Item (Join-Path $guardDir 'watchdog.pid') -Force -ErrorAction SilentlyContinue

# 3. Start dsh the normal way: Start-Process gives it a fresh, visible console
#    window, which is also what makes its background jobs stop opening their own.
Write-Output "starting dsh in a new console window ..."
$env:DSH_HOME = $DshHome
Start-Process -FilePath 'node' -ArgumentList @($DshEntry, 'web', '--port', [string]$Port) -WindowStyle Normal | Out-Null

# 4. Wait for it to answer.
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$ready = $false
while ((Get-Date) -lt $deadline) {
    if (Test-Port $Port) { $ready = $true; break }
    Start-Sleep -Milliseconds 700
}
if ($ready) {
    Write-Output "dsh is up at http://127.0.0.1:$Port"
    Write-Output 'refresh the browser; the guard will start a fresh watchdog on this boot'
    exit 0
}

Write-Output "dsh did not answer on $Port within $WaitSeconds s."
Write-Output "Check the console window it opened, or run: node `"$DshEntry`" web --port $Port"
exit 1
