# guard-autostart.ps1 - the safety net a plugin cannot be.
#
# A dsh plugin lives inside the process it guards, so it cannot bring anything
# back once that process is gone. This script runs from the Windows Task
# Scheduler (installed by install-guard.ps1 as `dsh-guard-autostart`, every two
# minutes) and does the one thing left: if a dsh-guard instance is no longer
# running and nobody wrote a clean-exit marker, start its watchdog directly.
#
# What it does NOT do is start a second dsh. The watchdog is the thing that knows
# the exact command line, so this script only resurrects the watchdog — or, if
# dsh is alive but its watchdog died, replaces just the watchdog.
#
# Every run appends a line to <DshHome>/guard/autostart.log so an unattended
# machine leaves a trail.
#
# Usage:
#   pwsh -File guard-autostart.ps1            # one pass (what the task runs)
#   pwsh -File guard-autostart.ps1 -Verbose   # one pass, report every instance
param(
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
    [string]$StateDir = '',
    # An instance record older than this is treated as abandoned: the plugin
    # refreshes it every 30 seconds while dsh is alive, so a stale record means
    # the whole tree died (or was force-killed) rather than that dsh is fine.
    [int]$StaleMinutes = 5,
    # Passed through to the watchdog: "halt" (default) stops supervision when the
    # recorded port is held by a foreign process; "replace" kills the holder.
    [ValidateSet('halt', 'replace')]
    [string]$PortConflict = 'halt',
    [switch]$DryRun,
    [switch]$Verbose
)

$ErrorActionPreference = 'Continue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$guardRoot = if ($StateDir -ne '') { $StateDir } else { Join-Path $DshHome 'guard' }
$logPath = Join-Path $guardRoot 'autostart.log'
$logDir = Split-Path $logPath -Parent

function Write-Log([string]$Message) {
    $line = "$(Get-Date -Format o)`t$Message"
    try {
        if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
        [System.IO.File]::AppendAllText($logPath, "$line`n", $utf8)
    } catch { }
    if ($Verbose) { Write-Output $line }
}

# NOTE: the parameter must NOT be named $Pid. PowerShell defines $PID as a
# read-only automatic variable, and binding a function parameter to a read-only
# name throws mid-run -- which silently turned every liveness check into "false"
# the first time this script was exercised against real data.
function Test-Pid([object]$ProcessId) {
    if ($null -eq $ProcessId) { return $false }
    $value = 0
    if (-not [int]::TryParse([string]$ProcessId, [ref]$value)) { return $false }
    if ($value -le 0) { return $false }
    return $null -ne (Get-Process -Id $value -ErrorAction SilentlyContinue)
}

function Read-Json([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    try { return (Get-Content -Path $Path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

# Every guard state directory this machine knows about: the default one plus any
# `<guardRoot>/instances/*.json` registry entries a second dsh may have written
# (a different --port produces a different instance file under the same root).
$stateDirs = New-Object System.Collections.Generic.List[string]
$stateDirs.Add($guardRoot)
$registry = Join-Path $guardRoot 'instances'
if (Test-Path $registry) {
    foreach ($file in Get-ChildItem $registry -Filter '*.json' -ErrorAction SilentlyContinue) {
        $record = Read-Json $file.FullName
        if ($null -ne $record -and $null -ne $record.stateDir) { $stateDirs.Add([string]$record.stateDir) }
    }
}

$seen = @{}
foreach ($dir in $stateDirs) {
    if ($seen.ContainsKey($dir)) { continue }
    $seen[$dir] = $true
    if (-not (Test-Path $dir)) { continue }

    $instance = Read-Json (Join-Path $dir 'instance.json')
    if ($null -eq $instance) { continue }

    $cleanExit = Read-Json (Join-Path $dir 'clean-exit.json')
    $stop = Read-Json (Join-Path $dir 'stop.json')
    if ($null -ne $cleanExit -or $null -ne $stop) {
        if ($Verbose) { Write-Log "skip $dir : clean exit recorded" }
        continue
    }

    $dshAlive = Test-Pid $instance.pid
    $watchdog = Read-Json (Join-Path $dir 'watchdog.pid')
    $watchdogAlive = if ($null -ne $watchdog) { Test-Pid $watchdog.pid } else { $false }

    if ($dshAlive -and $watchdogAlive) { continue }

    if (-not $dshAlive) {
        # Freshness gate: an old record means dsh has been gone a while, and
        # relaunching it then would surprise whoever is working. Recency is the
        # difference between "recover the crash that just happened" and
        # "resurrect a session from last week".
        $stamp = $null
        try { $stamp = ([datetime]$instance.updatedAt).ToLocalTime() } catch { $stamp = $null }
        if ($null -ne $stamp -and $stamp -lt (Get-Date).AddMinutes(-1 * $StaleMinutes)) {
            Write-Log "skip $dir : dsh pid $($instance.pid) is gone and its record is stale ($($stamp.ToString('yyyy-MM-dd HH:mm:ss')))"
            continue
        }
    }

    $entry = $instance.args[0]
    if ($null -eq $entry -or -not (Test-Path $entry)) {
        Write-Log "cannot recover $dir : entry script '$entry' is missing"
        continue
    }
    $script = [string]$instance.watchdogScript
    if ($script -eq '' -or -not (Test-Path $script)) {
        # Fall back to the conventional location when the record predates the
        # watchdogScript field.
        $script = Join-Path (Split-Path (Split-Path $entry -Parent) -Parent) 'node_modules\dsh-guard\bin\watchdog.mjs'
    }
    if (-not (Test-Path $script)) {
        Write-Log "cannot recover $dir : watchdog script not found (looked at '$script')"
        continue
    }

    $arguments = @(
        "`"$script`"",
        '--state-dir', "`"$dir`"",
        '--parent-pid', [string]$instance.pid,
        '--delay-ms', '1500',
        '--max-restarts', '10',
        '--window-ms', '600000',
        '--port-conflict', $PortConflict,
        '--rapid-death-ms', '3000',
        '--max-rapid-restarts', '3'
    ) -join ' '
    try {
        if ($DryRun) {
            Write-Log "dry run: would start `"$script`" --state-dir `"$dir`" --parent-pid $($instance.pid)"
        } else {
            Start-Process -FilePath 'node' -ArgumentList $arguments -WindowStyle Hidden | Out-Null
            if ($dshAlive) { Write-Log "watchdog resurrected for live dsh pid $($instance.pid) in $dir" }
            else { Write-Log "watchdog started for dead dsh pid $($instance.pid) in $dir (it will relaunch dsh)" }
        }
    } catch {
        Write-Log "failed to start the watchdog for ${dir}: $($_.Exception.Message)"
    }
}
