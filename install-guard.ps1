# install-guard.ps1 - (re)install the dsh-guard plugin into a dsh profile.
#
# Idempotent. Two install shapes:
#
#   -Link   (default)  a directory junction from the profile's node_modules to
#                      this source tree. Code edits take effect on the next dsh
#                      start with no reinstall, which is what you want while
#                      developing or iterating.
#   -Copy              copy the package into the profile. Use it to freeze a
#                      known-good revision, or when junctions are undesirable.
#
# Then the profile patch (cordis.patch.yml) is made to mount the plugin exactly
# once. A mount row a human has edited is left alone: this script says so and
# leaves the file untouched rather than rebuilding it from the template and
# silently dropping those settings. Pass -ResetPatch to force the template.
#
# It also installs the external safety net that a plugin cannot install for
# itself: a scheduled task that every few minutes checks whether a dsh-guard
# instance is running and, when both dsh and its watchdog are gone, brings the
# watchdog back. A plugin runs inside the process it is watching, so it can
# never be the last line of defence.
#
# Usage:
#   powershell -File install-guard.ps1               # junction + patch + autostart
#   powershell -File install-guard.ps1 -Copy         # copy instead of junction
#   powershell -File install-guard.ps1 -NoAutoStart  # plugin only, no scheduled task
#   powershell -File install-guard.ps1 -FilesOnly    # ship code, do not touch the patch
#   powershell -File install-guard.ps1 -ResetPatch   # rebuild the mount row from the template
#   powershell -File install-guard.ps1 -Test         # run the offline test suite
param(
    [string]$Profile = 'web',
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
    [switch]$Copy,
    [switch]$Link,
    [switch]$FilesOnly,
    [switch]$ResetPatch,
    [switch]$NoAutoStart,
    [switch]$Test
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell reads and writes scripts as ANSI by default, which mangles
# the Chinese text this plugin's patch block carries. Every read/write here goes
# through explicit UTF-8 without a BOM.
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Read-Text([string]$Path) { return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) }
function Write-Text([string]$Path, [string]$Text) { [System.IO.File]::WriteAllText($Path, $Text, $utf8) }

$source = $PSScriptRoot
$profileDir = Join-Path $DshHome "profiles\$Profile"
$target = Join-Path $profileDir 'node_modules\dsh-guard'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$taskName = 'dsh-guard-autostart'
$autostartScript = Join-Path $source 'guard-autostart.ps1'

if ($Test) {
    Push-Location $source
    try {
        foreach ($suite in @('snapshot.test.mjs', 'watchdog-policy.test.mjs')) {
            Write-Output "--- $suite"
            & node (Join-Path $source "test\$suite")
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        Write-Output '--- check-patch.mjs'
        & node (Join-Path $source 'test\check-patch.mjs') $patchPath
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

        # The only suite that boots a dsh. It builds its own throwaway DSH_HOME,
        # profile, port and state directory, so running it cannot disturb the
        # installation this script just touched.
        Write-Output '--- quit-e2e.mjs (isolated: starts a throwaway dsh)'
        & node (Join-Path $source 'test\quit-e2e.mjs')
    } finally { Pop-Location }
    exit $LASTEXITCODE
}

if (-not (Test-Path (Join-Path $source 'lib\index.js'))) { throw "dsh-guard source not found at $source" }
if (-not (Test-Path $profileDir)) { throw "dsh profile not found at $profileDir; boot 'dsh --profile $Profile' once first" }

# ---------------------------------------------------------------------------
# 1. Place the package in the profile.
# ---------------------------------------------------------------------------
if (Test-Path $target) {
    $item = Get-Item $target -Force
    if ($item.LinkType -ne $null) { Remove-Item $target -Force -Recurse }
    else { Remove-Item $target -Recurse -Force }
}

$useLink = -not $Copy
if ($useLink) {
    try {
        New-Item -ItemType Junction -Path $target -Target $source | Out-Null
        Write-Output "linked: $target -> $source"
    } catch {
        Write-Output "junction failed ($($_.Exception.Message)); falling back to a copy"
        $useLink = $false
    }
}
if (-not $useLink) {
    New-Item -ItemType Directory -Path (Join-Path $target 'lib') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $target 'bin') -Force | Out-Null
    foreach ($file in @('package.json', 'README.md', 'README.zh.md', 'LICENSE', 'cordis.patch.snippet.yml')) {
        if (Test-Path (Join-Path $source $file)) { Copy-Item (Join-Path $source $file) (Join-Path $target $file) -Force }
    }
    Copy-Item (Join-Path $source 'lib\*.js') (Join-Path $target 'lib\') -Force
    Copy-Item (Join-Path $source 'bin\*.mjs') (Join-Path $target 'bin\') -Force
    Write-Output "copied: $target"
}

# ---------------------------------------------------------------------------
# 2. Mount it in the profile patch, exactly once.
#
# The managed region is delimited by explicit BEGIN/END markers rather than
# inferred from indentation: the first version of this installer guessed where
# the block ended, guessed wrong, and left the profile mounting dsh-guard twice.
# A marker cannot be guessed wrong.
# ---------------------------------------------------------------------------
$beginMarker = '>>> dsh-guard managed block'
$endMarker = '<<< dsh-guard managed block'

# Keys a human is expected to tune. Their presence outside the managed block
# means the row was customized by hand and must not be silently rebuilt.
$handEdited = @('stateDir', 'watchdog', 'autoResume', 'restartDelayMs', 'maxRestarts', 'crashWindowMs', 'resumePrompt', 'keepSessions')

function Remove-ManagedBlock {
    param([string]$Content)
    $kept = New-Object System.Collections.Generic.List[string]
    $skipping = $false
    foreach ($line in ($Content -split "`r?`n")) {
        if (-not $skipping -and $line.Contains($beginMarker)) { $skipping = $true; continue }
        if ($skipping) {
            if ($line.Contains($endMarker)) { $skipping = $false }
            continue
        }
        $kept.Add($line)
    }
    return (($kept -join "`n").TrimEnd() + "`n")
}

# Remove a mount row that predates the markers (written by an older version of
# this installer, or by hand). -ResetPatch needs this: without it the reset
# appends the managed block NEXT TO the legacy rows, and the profile ends up
# mounting dsh-guard two or three times - which is exactly what happened once.
function Remove-LegacyRows {
    param([string]$Content)
    $kept = New-Object System.Collections.Generic.List[string]
    $droppingRow = $false
    foreach ($line in ($Content -split "`r?`n")) {
        if (-not $droppingRow -and $line -match "name:\s*'dsh\-guard'\s*$") {
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
    return (($kept -join "`n").TrimEnd() + "`n")
}

if ($FilesOnly) {
    Write-Output ''
    Write-Output 'FilesOnly: the profile patch was not touched.'
    Write-Output 'Restart dsh for the plugin (and its Quit button) to load.'
} else {
    if (-not (Test-Path $patchPath)) { throw "profile patch not found at $patchPath" }
    $snippetPath = Join-Path $source 'cordis.patch.snippet.yml'
    if (-not (Test-Path $snippetPath)) { throw "patch template not found at $snippetPath" }
    $snippet = (Read-Text $snippetPath).TrimEnd()

    $content = Read-Text $patchPath
    $mounted = $content.Contains($beginMarker)
    $mentioned = $content -match "name:\s*'dsh\-guard'"

    # A hand-written row (outside our markers) wins: report it instead of
    # duplicating the mount.
    $customized = @()
    if ($mentioned -and -not $mounted) {
        $inRow = $false
        foreach ($line in ($content -split "`r?`n")) {
            if ($line -match "name:\s*'dsh\-guard'") { $inRow = $true; continue }
            if ($inRow) {
                if ($line -match '^\s{4,}\S') {
                    foreach ($key in $handEdited) { if ($line -match "^\s+$key\s*:") { $customized += $key } }
                    continue
                }
                $inRow = $false
            }
        }
    }

    if ($mentioned -and -not $mounted -and -not $ResetPatch) {
        Write-Output ''
        Write-Output 'patch NOT touched: dsh-guard is already mounted by a hand-written row'
        if ($customized.Count -gt 0) { Write-Output "  (it carries hand-written settings: $($customized -join ', '))" }
        Write-Output 'The code is in place - just restart dsh. Use -ResetPatch to replace that row with the managed block.'
    } else {
        # Strip the managed block first, then any legacy rows it may coexist with,
        # so exactly one mount row survives no matter what the file looked like.
        $body = Remove-ManagedBlock -Content $content
        $legacy = 0
        if ($body -match "name:\s*'dsh\-guard'") {
            $legacy = ([regex]::Matches($body, "name:\s*'dsh\-guard'\s*$", 'Multiline')).Count
            $body = Remove-LegacyRows -Content $body
        }
        if ($body.Trim() -eq '[]') { $body = '' }
        $backup = "$patchPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item $patchPath $backup -Force
        $next = ($body.TrimEnd() + "`n`n" + $snippet + "`n").TrimStart("`n")
        Write-Text $patchPath $next
        if ($mounted) { Write-Output "patch refreshed (managed block replaced): $patchPath" }
        else { Write-Output "patch updated (dsh-guard mounted): $patchPath" }
        if ($legacy -gt 0) { Write-Output "also removed $legacy legacy dsh-guard row(s) that predated the markers" }
        Write-Output "backup: $backup"
    }
}

# ---------------------------------------------------------------------------
# 3. The external safety net: a scheduled task that resurrects a dead watchdog.
# ---------------------------------------------------------------------------
if ($NoAutoStart) {
    Write-Output ''
    Write-Output 'NoAutoStart: no scheduled task installed.'
} elseif (-not (Test-Path $autostartScript)) {
    Write-Output ''
    Write-Output "autostart script missing at $autostartScript; skipped"
} else {
    # Register the task against the PowerShell that is running this script, so it
    # works whether that is powershell.exe (5.1) or pwsh (7+).
    $hostExe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $action = New-ScheduledTaskAction -Execute $hostExe `
        -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$autostartScript`" -DshHome `"$DshHome`"" `
        -WorkingDirectory $source
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
        -RepetitionInterval (New-TimeSpan -Minutes 2)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -Hidden
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    try {
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
            -Principal $principal -Force `
            -Description 'dsh-guard: restart the dsh watchdog when both dsh and its watchdog are gone.' | Out-Null
        Write-Output "scheduled task installed: $taskName (every 2 minutes, via $hostExe)"
    } catch {
        Write-Output "could not install the scheduled task: $($_.Exception.Message)"
        Write-Output 'install it by hand if you want unattended recovery, or re-run from an elevated shell.'
    }
}

Write-Output ''
Write-Output 'Done. Next steps:'
Write-Output "  1. restart dsh (the sidebar's Quit button appears beside Settings)"
Write-Output "  2. state lives in $DshHome\guard (snapshot.json / resume.md / crash.json / crashes.log / dsh.log / watchdog.log)"
Write-Output "  3. set autoResume: true in $patchPath to continue the interrupted task automatically"
