# guard-status.ps1 - one-screen report on the dsh-guard state directory (read-only).
#
# Answers: is dsh alive, is the watchdog alive, what died last, and what was the
# task when it died. No browser needed.
#
# Usage:
#   powershell -File guard-status.ps1
#   powershell -File guard-status.ps1 -Resume     # also print the resume brief
#   powershell -File guard-status.ps1 -Log        # also tail watchdog.log + crashes.log
param(
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
    [string]$StateDir = '',
    [switch]$Resume,
    [switch]$Log
)

$ErrorActionPreference = 'Continue'
$guard = if ($StateDir -ne '') { $StateDir } else { Join-Path $DshHome 'guard' }

function Read-Json([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    try { return (Get-Content -Path $Path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}
function Test-Pid([object]$Pid) {
    $value = 0
    if ($null -eq $Pid -or -not [int]::TryParse([string]$Pid, [ref]$value) -or $value -le 0) { return $false }
    return $null -ne (Get-Process -Id $value -ErrorAction SilentlyContinue)
}
function Stamp([object]$Iso) {
    if ($null -eq $Iso -or [string]$Iso -eq '') { return '-' }
    try { return ([datetime]$Iso).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss') } catch { return [string]$Iso }
}
function Clip([string]$Text, [int]$Max) {
    if ($null -eq $Text) { return '' }
    if ($Text.Length -le $Max) { return $Text }
    return $Text.Substring(0, $Max) + '...'
}

Write-Output "state dir : $guard"
if (-not (Test-Path $guard)) {
    Write-Output '状态目录不存在：dsh-guard 从未在这个 stateDir 上运行过。'
    exit 0
}

$instance = Read-Json (Join-Path $guard 'instance.json')
$clean = Read-Json (Join-Path $guard 'clean-exit.json')
$stop = Read-Json (Join-Path $guard 'stop.json')
$watchdog = Read-Json (Join-Path $guard 'watchdog.pid')
$snapshot = Read-Json (Join-Path $guard 'snapshot.json')
$crash = Read-Json (Join-Path $guard 'crash.json')
$watchCrash = Read-Json (Join-Path $guard 'watchdog-crash.json')

Write-Output ''
Write-Output '--- 进程 ---'
if ($null -ne $instance) {
    $alive = Test-Pid $instance.pid
    $state = if ($alive) { '(运行中)' } else { '(已退出)' }
    Write-Output ("dsh       : pid {0} {1}  port {2}" -f $instance.pid, $state, $instance.port)
    Write-Output ("            cwd {0}" -f $instance.cwd)
    Write-Output ("            started {0}  heartbeat {1}" -f (Stamp $instance.startedAt), (Stamp $instance.updatedAt))
} else {
    Write-Output 'dsh       : instance.json 缺失'
}
if ($null -ne $watchdog) {
    $watchAlive = Test-Pid $watchdog.pid
    $state = if ($watchAlive) { '(运行中)' } else { '(已退出)' }
    Write-Output ("watchdog  : pid {0} {1}" -f $watchdog.pid, $state)
} else {
    Write-Output 'watchdog  : watchdog.pid 缺失（看门狗未启动或已停止）'
}
if ($null -ne $clean) {
    Write-Output ("退出标记  : 正常退出于 {0}（看门狗已随之停止）" -f (Stamp $clean.at))
} elseif ($null -ne $stop) {
    Write-Output ("退出标记  : 停止标记 {0}" -f (Stamp $stop.at))
} else {
    Write-Output '退出标记  : 无（上次不是通过「退出」按钮结束的）'
}

Write-Output ''
Write-Output '--- 上次死亡 ---'
if ($null -ne $watchCrash) {
    Write-Output ("判定      : {0}" -f $watchCrash.reason)
    Write-Output ("退出码    : {0}  信号 {1}  存活 {2} ms" -f $watchCrash.exitCode, $watchCrash.signal, $watchCrash.livedMs)
    Write-Output ("时间      : {0}" -f (Stamp $watchCrash.at))
    if ($null -ne $watchCrash.pluginCrash) {
        Write-Output ("插件记录  : {0} — {1}" -f $watchCrash.pluginCrash.reason, $watchCrash.pluginCrash.detail)
        if ($null -ne $watchCrash.pluginCrash.stack) {
            $firstLine = ([string]$watchCrash.pluginCrash.stack -split "`r?`n")[0]
            Write-Output ("首行栈    : {0}" -f $firstLine)
        }
    }
    if ($null -ne $watchCrash.windowsEvents -and @($watchCrash.windowsEvents).Count -gt 0) {
        Write-Output 'Windows 应用日志（进程被系统级终止时唯一的外部证据）:'
        foreach ($event in $watchCrash.windowsEvents) {
            Write-Output ("  {0}  {1}" -f $event.at, $event.provider)
            Write-Output ("    {0}" -f (Clip ([string]$event.message) 200))        }
    }
} elseif ($null -ne $crash) {
    Write-Output ("插件记录  : {0} — {1}（{2}）" -f $crash.reason, $crash.detail, (Stamp $crash.at))
} else {
    Write-Output '没有死亡记录。'
}

Write-Output ''
Write-Output '--- 任务快照 ---'
if ($null -ne $snapshot) {
    Write-Output ("会话      : {0}" -f $snapshot.sessionId)
    Write-Output ("阶段      : {0}  中断={1}  turn={2} step={3}" -f $snapshot.phase, $snapshot.interrupted, $snapshot.turn, $snapshot.step)
    Write-Output ("快照时间  : {0}" -f (Stamp $snapshot.updatedAt))
    $counts = $snapshot.todoCounts
    if ($null -ne $counts) {
        Write-Output ("任务列表  : {0} 完成 / {1} 进行中 / {2} 待办" -f $counts.completed, $counts.inProgress, $counts.pending)
        foreach ($todo in $snapshot.todos) {
            $mark = if ($todo.status -eq 'completed') { '[x]' } elseif ($todo.status -eq 'in_progress') { '[>]' } else { '[ ]' }
            Write-Output ("  {0} {1}" -f $mark, $todo.content)
        }
    } else {
        Write-Output '任务列表  : 本会话没有 todo_write 记录'
    }
    Write-Output ("文件      : {0}" -f (Join-Path $guard 'snapshot.json'))
    Write-Output ("续跑说明  : {0}" -f (Join-Path $guard 'resume.md'))
} else {
    Write-Output '还没有快照。'
}

if ($Resume) {
    Write-Output ''
    Write-Output '--- resume.md ---'
    $brief = Join-Path $guard 'resume.md'
    if (Test-Path $brief) { Get-Content $brief -Encoding UTF8 } else { Write-Output '(缺失)' }
}

if ($Log) {
    foreach ($name in @('watchdog.log', 'crashes.log', 'autostart.log')) {
        Write-Output ''
        Write-Output "--- $name (最后 25 行) ---"
        $path = Join-Path $guard $name
        if (Test-Path $path) { Get-Content $path -Encoding UTF8 -Tail 25 } else { Write-Output '(缺失)' }
    }
}
