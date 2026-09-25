# dsh-guard

给 dsh（DeepSeek Harness）Web GUI 用的「崩溃守夜人」：一个 Cordis 插件 + 一组脚本。

它解决四件事：

- **界面上的「退出」按钮** —— 就在侧边栏底部「设置」按钮旁边，点击后正常终止 dsh 进程（不是 kill）。
- **独立于 dsh 的看门狗进程** —— dsh 被异常终止时，由它重启 dsh；因为它不在 dsh 进程里，dsh 整个进程死掉也拦不住它。
- **重启不会无限进行** —— **重启后又立刻崩溃，它会自行放弃并留下原因**，而不是一遍遍刷出注定失败的进程。
- **运行中任务的快照** —— 尤其是**任务列表（todo list）**：每次进程意外终止都会丢的那份，现在被持续落盘，可直接拿来续跑。
- **崩溃取证** —— 不再静默退出：未捕获异常、未处理的 Promise 拒绝、退出码、以及 Windows 应用日志里的进程级死亡记录都会留下痕迹。

---

## 一、装什么、装在哪

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| 插件（host 半边） | `lib/index.js` | 崩溃记录、快照落盘、`/dsh-guard/*` 路由、优雅退出、拉起看门狗 |
| 插件（browser 半边） | `lib/client.js` | 在 `sidebar.footer.action` 槽位注册「退出」按钮 |
| 看门狗 | `bin/watchdog.mjs` | 独立进程：重启 dsh、判定死因、按策略退避 |
| 安装器 | `install-guard.ps1` | 装进 profile（默认 junction 链接）、改 profile patch、装计划任务 |
| 卸载器 | `uninstall-guard.ps1` | 停看门狗、删计划任务、摘插件、还原 patch |
| 状态查看 | `guard-status.ps1` | 只读报表：进程、上次死因、任务快照 |
| 兜底拉起 | `guard-autostart.ps1` | 计划任务每 2 分钟跑一次：dsh 和看门狗都没了时把看门狗拉回来 |

状态目录默认 `%USERPROFILE%\.dsh\guard`（即 `$DSH_HOME/guard`）：

```
instance.json        本次 dsh 的启动配方：execPath + argv + cwd + port（每 30 秒心跳刷新）
status.json          最近一次状态快照（GET /dsh-guard/status 的落盘版）
snapshot.json        运行中任务快照（结构化）
resume.md            同上的可读版，直接粘贴给 agent 就能续跑
session-refs.json    最近若干会话的 id / cwd / 阶段
sessions/<id>.json   每个会话各自的快照（保留最近 keepSessions 份）
crash.json           最近一次崩溃的完整记录（含堆栈）
crashes.log          一行一条：插件侧 + 看门狗侧的死亡记录
watchdog-crash.json  看门狗对上次死亡的判定（退出码、信号、存活时长、Windows 日志）
dsh.log              dsh 的 stdout+stderr（看门狗接管，崩溃时一定有日志）
watchdog.log         看门狗自己的日志
autostart.log        兜底计划任务的日志
clean-exit.json      点「退出」按钮后写下 —— 看门狗看到它就自行退出
```

---

## 二、安装 / 激活

```powershell
# 1) 装进 web profile（默认 junction，改代码后下次启动即生效）
powershell -ExecutionPolicy Bypass -File .\install-guard.ps1

# 2) 让 dsh 重新加载：在 GUI 里点新出现的「退出」按钮，或手动重启 dsh
```

**插件只在 dsh 启动时挂载。** 安装脚本改的是 profile 的 `cordis.patch.yml`，
它在下一次 dsh 启动时生效 —— 不会打断当前正在跑的任务。

常用变体：

```powershell
.\install-guard.ps1 -NoAutoStart     # 不装计划任务，只要插件 + 看门狗
.\install-guard.ps1 -Copy            # 复制而不是 junction（冻结版本用）
.\install-guard.ps1 -FilesOnly       # 只更新代码，不碰 patch
.\install-guard.ps1 -ResetPatch      # 强制用模板重建挂载块
.\install-guard.ps1 -Test            # 只跑离线测试
.\install-guard.ps1 -DshHome D:\dsh-home -Profile web
```

卸载：

```powershell
.\uninstall-guard.ps1            # 摘插件，保留状态目录（崩溃历史通常要留着）
.\uninstall-guard.ps1 -Purge     # 连状态目录一起删
```

查看：

```powershell
.\guard-status.ps1               # 进程 + 上次死因 + 任务列表
.\guard-status.ps1 -Resume       # 额外打印 resume.md 全文
.\guard-status.ps1 -Log          # 额外打印三个日志的尾部
```

---

## 三、配置

挂在 profile 的 `cordis.patch.yml` 里（安装器写入的块在 `>>> dsh-guard managed block` 标记之间）：

```yaml
- insert:
    - id: guard
      name: 'dsh-guard'
      config:
        stateDir: ''          # 空 = $DSH_HOME/guard
        watchdog: true        # 拉起独立看门狗进程
        autoResume: false     # 重启后自动往原会话注入续跑 prompt（默认关）
        restartDelayMs: 1500  # 正常重启间隔
        maxRestarts: 10       # crashWindowMs 窗口内最多重启几次
        crashWindowMs: 600000 # 10 分钟窗口
        rapidDeathMs: 3000    # 存活不足这个时间算「刚起来就崩」
        maxRapidRestarts: 3   # 连续几次「刚起来就崩」后放弃重启
        portConflict: halt    # 端口被占：halt=停下诊断 / replace=杀掉占用者
        tailEvents: 40        # 快照里保留多少条最近事件
        timeoutMs: 4000       # 优雅退出的兜底超时
        keepSessions: 12      # 保留多少份 per-session 快照
        # resumePrompt: |     # 自定义续跑 prompt，{{snapshot}} 会被替换
```

### 重启的刹车（重要）

看门狗不会无脑循环拉起：

| 情况 | 行为 |
| --- | --- |
| dsh 崩一次 | 隔 `restartDelayMs` 重启一次 |
| 重启后又**立刻**崩（存活 < `rapidDeathMs`），连续 `maxRapidRestarts` 次 | **放弃**：写 `watchdog-halt.json`（`reason: rapid-crash-loop`）并退出 |
| 端口被别的进程占住 | 默认**放弃**：写 `halt`（`reason: port-conflict`），因为重启也只会 `EADDRINUSE` |
| 拉起的 dsh 日志里出现 `EADDRINUSE` | 立刻放弃（`reason: eaddrinuse`），不等次数阈值 |
| 窗口内崩溃次数超过 `maxRestarts` | 放弃（`reason` 见 `watchdog.log`） |

「刚起来就崩」的判断只看**重启出来**的进程：被守护的那个 dsh 第一次崩，
照样给它一次重启机会 —— 那可能只是偶发崩溃。放弃时 `watchdog-halt.json` 里带
`dshLogTail` 与 `advice`，所以「为什么反复崩」有据可查，而不是留下一堆孤儿进程。

`autoResume: true` 时，看门狗发现重启前有「任务执行中被中断」的快照，就会写一份
`resume-request.json`；新起来的 dsh 读到它，往**原会话**注入一条 user 消息（内容含
任务列表、崩溃原因、未收到结果的工具调用），agent 自己接着做。

> 默认 `false` 是刻意的：自动续跑会重放一轮工作，如果上一轮的写入其实已经落盘，
> 就可能重复副作用。要不要开由你定。

---

## 四、它到底怎么工作

### 退出按钮

浏览器半边是通过 `dsh.client` 清单发布的**客户端 bundle**：包在 `package.json` 里声明
`dsh.client.platform = "web"` 与 `exports["./client"]`，宿主把那个文件**原样**交给
`/plugins` 的 combo 路由，浏览器端的内核要求 bundle **自己**在
`window.__ModuleLoader__.load({ id, factory })` 里注册工厂。

⚠️ 这里有个容易致命的区别：**`dsh.client` bundle 不是动态包**。动态包（`tool-cordis`
那套）是一个 `return { name, inject, apply }` 的闭包体，由 runner 求值；而 `dsh.client`
bundle 必须自己注册工厂。写错格式的后果不是"按钮不出现"，而是**整个页面起不来**：

```
Failed to load plugins
bundle /plugins/??...dsh-guard/client.js&rev=... loaded without registering "..." via __ModuleLoader__.load
```

因为 combo 脚本是 boot 批次的一部分，一个没注册的成员会让整批导入失败。
`test/client-bundle.test.mjs` 复刻了内核的两条判据（"注册了吗" / "工厂返回的能挂载吗"）
外加"只能 require 平台种子模块"，专门看住这个坑。

插件然后通过 `ctx.slots.register({ name: 'sidebar.footer.action' })` 注册进
侧边栏底部「设置」旁边那一格（`sidebar.footer.action` 是侧边栏明确声明给
「设置旁的操作」的槽位）。点两下才退：第一下进入「再点一次退出」的确认态，3 秒后自动取消。

确认后 POST `/dsh-guard/quit`，host 半边依次做：

1. 写 `clean-exit.json` 和 `stop.json` —— 看门狗的免重启凭据；
2. 把当前任务快照刷盘；
3. `ctx.loader.stop()` 优雅拆树（会话日志正常 drain）；
4. 最多等 `timeoutMs`，然后 `process.exit(0)`。

看门狗看到标记后自己退出，**不留后台进程**。

### 看门狗

插件启动时用 `spawn(..., { detached: true })` + `unref()` 起一个独立进程，
并把本次的 `execPath + argv` 写进 `instance.json`。看门狗于是知道怎么原样重启 dsh。

之后它循环：起 dsh → 等它退出 → 判定：

| 情况 | 判定 |
| --- | --- |
| `stop.json` / `clean-exit.json` 存在 | 正常退出，不再拉起，看门狗自己退出 |
| 退出码非 0、被信号杀死、进程级死亡 | 异常终止 → 退避后重启 |
| 退出码 0 但没有 clean-exit 标记 | **仍然重启** —— 退出码不是承诺，`process.exit(0)` 也可能来自别处 |
| 被守护的 dsh 第一次崩 | 重启一次（可能只是偶发）——见上面「重启的刹车」 |
| 重启出来的进程连续「刚起来就崩」 | 放弃并写 `watchdog-halt.json`，不再刷进程 |
| 端口已被占用 / 新进程日志出现 `EADDRINUSE` | 立刻放弃，因为再拉起也只是重复同一次失败 |
| 看门狗自己被顶替（`instance.json` 换了 pid）| 自行退出，避免两个看门狗抢着重启同一个 dsh |

退避：正常间隔 `restartDelayMs`；存活不足 15 秒的崩溃按 4 倍退避（最高 20 秒）。

> 关于「被守护的 dsh 第一次崩」这条：`expectedParentPid` 就是看门狗自己拉起的那个
> 子进程，所以子进程一死，那个 pid 必然消失。**不能**用「父进程不在了」来判断自己成了孤儿
> —— 那会把第一次真正的崩溃误判成「我是多余的看门狗」而白白浪费掉唯一一次重启机会
> （这正是开发中踩过并修掉的坑）。孤儿看门狗由另外两条独立证据判定：`parentWatch`
> 定时器（未开始守护 + 记录的实例已换 pid）与启动前的端口探测（端口上已有活着的守卫）。

### 崩溃取证

- 插件侧：`uncaughtException` / `unhandledRejection` / `process.on('exit')` 三个钩子
  把原因、堆栈、当时的会话快照**同步**写到 `crash.json` + `crashes.log`。
  插件只记录、不改变退出行为（退出码仍由 cordis / 平台决定）。
- 看门狗侧：dsh 的 stdout/stderr 一直被追加到 `dsh.log`，所以即使 dsh 没来得及写日志也有输出；
  每次异常退出还会带上退出码、信号、存活时长、插件侧记录、以及 **Windows 应用日志**
  里同一时间窗内的 Application Error / Windows Error Reporting / .NET Runtime 事件 ——
  这是 OOM、访问违例、原生插件 abort 这类「静默死亡」唯一的外部证据。

### 任务快照

插件监听 `session/event`，把事件折叠成快照。重点字段：

- `todos` / `todoCounts` —— `todo/write` 事件的**最后一份完整列表**；
- `phase` / `interrupted` —— 有 `turn/start` 没等到 `turn/end` 就是「执行中被中断」；
- `openToolCalls` —— 发了 `tool/call` 但没收到 `tool/result` 的调用（重做前要先确认是否已生效）；
- `goal`、`lastUserMessage`、`lastAssistantText`、`tail`（最近事件）。

`todo/write`、`turn/start`、`turn/end`、`goal/change` 立即落盘，其余事件 400ms 防抖。

> **快照从插件挂载那一刻开始记。** `session/event` 只投递**新**事件，插件不会回放
> 挂载之前的会话历史，所以刚启用 dsh-guard 的那一轮，早先的 `todo/write` 不在快照里
> —— 直到 agent 下一次调用 `todo_write`。要立刻拿到当前列表，让它重发一次或直接看会话日志。

> **为什么任务列表会丢？** 列表本身是会话日志里的 `todo/write` 事件，日志是持久的；
> 但客户端侧投影在 `turn/start` 时被重置为 `null`，而崩溃时 agent 手上的那份内存状态也没了，
> 于是「界面/agent 看到的任务列表」凭空消失。dsh-guard 把它独立落盘，与日志生命周期解耦。

---

## 五、怎么续跑

崩溃后：

```powershell
.\guard-status.ps1 -Resume
```

会打印 `resume.md`（任务列表带 `[x]/[>]/[ ]` 标记、崩溃原因、未完成工具调用、
最后一条人类指令）。把这份文件或列表交给 agent 就行。

开了 `autoResume` 的话连这一步都省了 —— 但请先读上面那条关于重复副作用的提醒。

---

## 六、诚实的能力边界

- **插件和它守护的进程同生共死。** 所以「看门狗也被杀掉」这种情况插件无能为力，
  才需要 `install-guard.ps1` 注册的兜底计划任务（每 2 分钟一次）。
  该任务只重新拉起**看门狗**，不直接起 dsh；并且只对「记录仍然新鲜」的实例动手 ——
  记录每 30 秒心跳一次，变陈旧就说明这棵树早就死了，不会去复活一个几天前的会话。
- **计划任务只在你登录时运行**（`-LogonType Interactive`）。无人值守的无人登录场景需要
  改成服务/开机任务，这超出当前脚本范围。
- **Windows 应用日志查询依赖 `pwsh`**。没有 `pwsh` 时这一段取证为空，其余功能不受影响
  （会记一条提示）。计划任务本身会自动使用当前宿主 `powershell.exe`，不挑 `pwsh`。
- **退出按钮只停 dsh**，看门狗随之退出，不会去动别的 dsh 实例。
- **`restartDelayMs` 不是「重启耗时」**，是最短等待；dsh 自己启动要多久由它自己决定。
- 多个 dsh 实例共用同一个 `stateDir` 会互相覆盖 `instance.json`。
  需要多实例就各自配一个 `stateDir`。
- **热重载挂载不会重启正在跑的 dsh**：如果 profile 开了 `patchReload: live`，
  改 patch 会把插件挂进**当前**进程。此时看门狗启动前会先探测端口，发现「记录里的 pid
  仍在提供守卫服务」就直接退出，不会去拉起第二个 dsh。（这条是实测踩出来的：
  早期版本在这里会不断生成 `EADDRINUSE` 的僵尸进程。）

---

## 七、自检与测试

```powershell
node test/patch-guard.test.mjs     # profile patch 编辑器：幂等安装/卸载、不被别的插件误伤
node test/client-bundle.test.mjs   # 客户端 bundle 契约：注册工厂、只 require 种子模块
node test/snapshot.test.mjs        # 快照折叠、resume 简报、配置解析
node test/watchdog-policy.test.mjs # 重启判定、端口预检、启动配方读取
node test/check-patch.mjs <patch>  # 静态检查：dsh-guard 只挂一次、配置项类型正确
node test/quit-e2e.mjs             # 端点级验证：在临时 DSH_HOME 里起一次性 dsh
.\install-guard.ps1 -Test          # 以上全部（会启动一个一次性 dsh）
```

patch 的手术刀只有一把：`bin/patch-guard.mjs`。安装器与卸载器都调用它，
不再各自维护一份字符串处理 —— 之前两份互相独立、各自错在不同地方
（留下注释前言、留下没有子项的 `- insert:`、以及因为吃掉了 BEGIN 标记导致第二次运行
根本认不出那块区域），所以才会在一个 profile 里堆出四份重复注释和两个空 insert。

**加插件进 patch 前的退路**：这个工具会先备份 `cordis.patch.yml.bak-<时间戳>`。
手工改坏了就从备份恢复，或 `node bin/patch-guard.mjs --patch <file> --remove` 一键清干净。

`test/quit-e2e.mjs` 是唯一会真的启动 dsh 的测试，但它**完全隔离**：在系统临时目录里
造一个自己的 `DSH_HOME`、自己的 profile、自己的端口和状态目录，把本包 junction（或复制）
进那个 profile 的 `node_modules`，然后验证：

1. 插件挂载、`/dsh-guard/status` 可读、看门狗已拉起；
2. `POST /dsh-guard/quit` 返回 200 并写下 `clean-exit.json`；
3. 进程**自己**以退出码 0 结束（是优雅 dispose，不是被 kill）；
4. 看门狗看到标记后退出，没有第二个 dsh 被拉起。

它不读也不写你的真实 profile 与状态目录，所以在任何时候都能跑。

排错顺序：

1. `.\guard-status.ps1 -Log` —— 先看 `autostart.log` 和 `watchdog.log` 的报错；
2. GUI 里按钮没出现 → 确认 `cordis.patch.yml` 里有 dsh-guard 挂载块，且 dsh 已重启；
3. `/dsh-guard/status` 返回 404 → 插件没挂载（patch 没生效或没重启）；
4. 看门狗不重启 → 检查 `clean-exit.json` / `stop.json` 是否被残留（正常退出后才会有，
   手动启动 dsh 时插件会清掉）；
5. 反复重启后停住 → 看 `watchdog-halt.json`（`rapid-crash-loop` / `port-conflict` /
   `eaddrinuse`）与 `watchdog-crash.json` 的 `dshLogTail`。
