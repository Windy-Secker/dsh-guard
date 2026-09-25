# uninstall-guard.ps1 - remove dsh-guard from a dsh profile.
#
# Stops the watchdog for the named state directory, removes the scheduled task,
# removes the package from the profile, and strips the mount block from the
# profile patch. The state directory (snapshots, crash records, logs) is kept
# unless -Purge is passed, because the crash history is usually the reason to
# keep it.
#
# Usage:
#   powershell -File uninstall-guard.ps1                 # unmount, keep state
#   powershell -File uninstall-guard.ps1 -Purge          # also delete the state directory
#   powershell -File uninstall-guard.ps1 -StateDir D:\x  # explicit state directory
param(
    [string]$Profile = 'web',
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
    [string]$StateDir = '',
    [switch]$Purge,
    [switch]$KeepTask
)

$ErrorActionPreference = 'Continue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Read-Text([string]$Path) { return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) }
function Write-Text([string]$Path, [string]$Text) { [System.IO.File]::WriteAllText($Path, $Text, $utf8) }
function Read-Json([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    try { return (Get-Content -Path $Path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

$guard = if ($StateDir -ne '') { $StateDir } else { Join-Path $DshHome 'guard' }
$profileDir = Join-Path $DshHome "profiles\$Profile"
$target = Join-Path $profileDir 'node_modules\dsh-guard'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'

# --- 1. stop the watchdog (and, through it, nothing else) -------------------
$watchdog = Read-Json (Join-Path $guard 'watchdog.pid')
if ($null -ne $watchdog -and $null -ne $watchdog.pid) {
    $proc = Get-Process -Id $watchdog.pid -ErrorAction SilentlyContinue
    if ($null -ne $proc) {
        # The stop marker makes the watchdog stand down instead of restarting dsh
        # when its child exits.
        $marker = @{
            schema = 'dsh-guard/stop@1'
            at     = (Get-Date).ToString('o')
            reason = 'uninstall-guard.ps1'
        } | ConvertTo-Json
        Write-Text (Join-Path $guard 'stop.json') $marker
        Stop-Process -Id $watchdog.pid -Force -ErrorAction SilentlyContinue
        Write-Output "watchdog stopped: pid $($watchdog.pid)"
    } else {
        Write-Output "watchdog not running (recorded pid $($watchdog.pid))"
    }
    Remove-Item (Join-Path $guard 'watchdog.pid') -Force -ErrorAction SilentlyContinue
}

# --- 2. remove the scheduled task -------------------------------------------
if (-not $KeepTask) {
    $task = Get-ScheduledTask -TaskName 'dsh-guard-autostart' -ErrorAction SilentlyContinue
    if ($null -ne $task) {
        Unregister-ScheduledTask -TaskName 'dsh-guard-autostart' -Confirm:$false -ErrorAction SilentlyContinue
        Write-Output 'scheduled task removed: dsh-guard-autostart'
    }
}

# --- 3. remove the package --------------------------------------------------
if (Test-Path $target) {
    $item = Get-Item $target -Force
    if ($null -ne $item.LinkType) { Remove-Item $target -Force -Recurse }
    else { Remove-Item $target -Recurse -Force }
    Write-Output "removed: $target"
}

# --- 4. strip the patch -----------------------------------------------------
#
# All of this file surgery lives in ONE place: bin/patch-guard.mjs. Both installers
# used to carry their own copy of the same string manipulation, and both copies were
# wrong in different ways: they left the comment preamble behind, left an "- insert:"
# parent with no children, and - because consuming the BEGIN marker made a second run
# blind to the region - could no longer clean up what they had written.
$patchEditor = Join-Path $PSScriptRoot 'bin\patch-guard.mjs'

if (Test-Path $patchPath) {
    if (-not (Test-Path $patchEditor)) {
        Write-Output "cannot clean the patch: $patchEditor is missing"
    } else {
        $backup = "$patchPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        try {
            Copy-Item $patchPath $backup -Force -ErrorAction Stop
            $result = & node $patchEditor --patch $patchPath --remove 2>&1
            Write-Output ($result -join ' ')
            Write-Output "backup: $backup"
        } catch {
            Write-Output "could not rewrite the patch: $($_.Exception.Message)"
            Write-Output "run this script again with write access to $profileDir"
        }
    }
}

# --- 5. state directory -----------------------------------------------------
if ($Purge) {
    if (Test-Path $guard) {
        Remove-Item $guard -Recurse -Force -ErrorAction SilentlyContinue
        Write-Output "state directory purged: $guard"
    }
} else {
    Write-Output "state directory kept: $guard (use -Purge to delete it)"
}
Write-Output ''
Write-Output 'Restart dsh for the change to take effect.'
