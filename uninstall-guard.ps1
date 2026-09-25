# uninstall-guard.ps1 - remove dsh-guard from a dsh profile.
#
# Stops the watchdog for the named state directory, removes the scheduled task,
# removes the package from the profile, and strips the mount row from the profile
# patch. The state directory (snapshots, crash records, logs) is kept unless
# -Purge is passed, because the crash history is usually the reason to keep it.
#
# Usage:
#   pwsh -File uninstall-guard.ps1                 # unmount, keep state
#   pwsh -File uninstall-guard.ps1 -Purge          # also delete the state directory
#   pwsh -File uninstall-guard.ps1 -StateDir D:\x  # explicit state directory
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

# --- 4. strip the mount block ----------------------------------------------
if (Test-Path $patchPath) {
    $beginMarker = '>>> dsh-guard managed block'
    $endMarker = '<<< dsh-guard managed block'
    $content = Read-Text $patchPath
    if ($content.Contains($beginMarker) -or $content -match "name:\s*'dsh\-guard'") {
        $kept = New-Object System.Collections.Generic.List[string]
        $skippingBlock = $false   # inside the managed markers
        $droppingRow = $false     # inside a hand-written dsh-guard insert row
        foreach ($line in ($content -split "`r?`n")) {
            if (-not $skippingBlock -and $line.Contains($beginMarker)) { $skippingBlock = $true; continue }
            if ($skippingBlock) {
                if ($line.Contains($endMarker)) { $skippingBlock = $false }
                continue
            }
            if (-not $droppingRow -and $line -match "name:\s*'dsh\-guard'") {
                # Drop the sibling `- id: guard` line that precedes the name.
                $droppingRow = $true
                $last = $kept.Count - 1
                if ($last -ge 0 -and $kept[$last] -match '^\s*-\s*id:\s*guard\s*$') { $kept.RemoveAt($last) }
                continue
            }
            if ($droppingRow) {
                if ($line.Trim().Length -eq 0 -or $line -match '^\s{4,}\S') { continue }
                $droppingRow = $false
            }
            $kept.Add($line)
        }
        $backup = "$patchPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        try {
            Copy-Item $patchPath $backup -Force -ErrorAction Stop
            Write-Text $patchPath (($kept -join "`n").TrimEnd() + "`n")
            Write-Output "patch cleaned (backup: $backup)"
        } catch {
            Write-Output "could not rewrite the patch: $($_.Exception.Message)"
            Write-Output "run this script again with write access to $profileDir"
        }
    } else {
        Write-Output 'patch has no dsh-guard row'
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
