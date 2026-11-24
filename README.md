# dsh-guard

A crash guard for the DeepSeek Harness (dsh) Web GUI: one Cordis plugin plus a
small set of scripts.

Four things it does:

1. **A Quit button** in the sidebar, beside Settings. It terminates dsh
   gracefully instead of killing it.
2. **A watchdog process outside dsh.** Because it is not inside the process it
   watches, it survives dsh dying and can relaunch it.
3. **A live task snapshot**, above all the **todo list** that used to evaporate
   on every abnormal exit — written to disk continuously and directly reusable
   to continue the work.
4. **A reason for every death.** `uncaughtException`, `unhandledRejection`, exit
   codes, and process-level Windows Application-log records, so dsh stops
   exiting silently.

See `README.zh.md` for the full documentation (Chinese; it is the primary one).
The short version:

```powershell
# install into the web profile (junction by default), then restart dsh
powershell -ExecutionPolicy Bypass -File .\install-guard.ps1

# watch it
.\guard-status.ps1 -Resume
.\guard-status.ps1 -Log

# remove
.\uninstall-guard.ps1
```

State lives in `$DSH_HOME/guard` (`instance.json`, `snapshot.json`, `resume.md`,
`crash.json`, `crashes.log`, `dsh.log`, `watchdog.log`, `clean-exit.json`).

Configuration (profile `cordis.patch.yml`):

| key | default | meaning |
| --- | --- | --- |
| `stateDir` | `$DSH_HOME/guard` | where every state file goes |
| `watchdog` | `true` | spawn the detached supervisor |
| `autoResume` | `false` | inject a resume prompt into the interrupted session after a restart |
| `restartDelayMs` | `1500` | delay before a restart |
| `maxRestarts` / `crashWindowMs` | `10` / `600000` | boot-loop brake |
| `rapidDeathMs` / `maxRapidRestarts` | `3000` / `3` | **a restart that dies this fast, this many times in a row, ends supervision** instead of retrying |
| `portConflict` | `halt` | when the recorded port is held elsewhere: `halt` diagnoses and stops, `replace` kills the holder |
| `restartWindow` | `visible` | console window of a restarted dsh: `visible` shows it, `hidden` keeps it off screen (a console exists either way, so background jobs stop popping windows) |
| `watchdogCheckMs` | `60000` | how often the plugin checks that its watchdog is still alive and replaces a dead one (`0` disables) |
| `tailEvents` | `40` | recent events kept in the snapshot |
| `timeoutMs` | `4000` | graceful-shutdown backstop |
| `keepSessions` | `12` | per-session snapshots retained |

Giving up is loud, not silent: the reason lands in `watchdog-halt.json`
(`rapid-crash-loop`, `port-conflict`, `eaddrinuse`) together with the tail of the
failed dsh's output, so a boot loop leaves a diagnosis rather than a pile of
orphan processes.

Tests: `node test/patch-guard.test.mjs` (profile-patch editor: idempotent
install/remove), `node test/client-bundle.test.mjs` (the served bundle must
register a factory on `window.__ModuleLoader__` and may only require platform
seed modules), `node test/snapshot.test.mjs`, `node test/watchdog-policy.test.mjs`,
`node test/check-patch.mjs <patch>`, or `.\install-guard.ps1 -Test` for all of
those. Two suites boot a throwaway dsh in an isolated `DSH_HOME`:
`node test/quit-e2e.mjs` proves the graceful path (status route, the served
client bundle registers, the watchdog is still ALIVE seconds after boot, quit
accepted, `clean-exit.json` written, exit code 0, watchdog stands down), and
`node test/crash-e2e.mjs` proves the rest: force-kill twice, a replacement dsh
appears on the same port both times with a crash report, then a graceful quit
stops supervision.

Watchdog lifecycle, in one line: it is started by the dsh it guards, so it
**waits for that process to exit** and only then takes over — spawning earlier
causes EADDRINUSE loops, standing down instead leaves every normal boot with no
supervisor. A replacement dsh adopts the already-running watchdog rather than
starting a second one.

A restarted dsh runs inside a real console on purpose. A console-less process
does not merely lack a window: every console child it starts gets a *new* console
window, so each of dsh's background-job children popped a black box. The watchdog
therefore asks PowerShell for a console and runs `bin/console-host.mjs` inside it;
the host runs dsh as its child (which inherits the console), tees dsh's output to
the window and to `dsh.log`, and reports the real exit code in
`dsh.log.exit.json`. `restartWindow: visible` (default) shows that window;
`hidden` keeps it off screen while preserving the console.

`restore-normal.ps1` is the emergency exit for testing: it stops the watchdog so
nothing races for the port, then starts dsh the ordinary way in a visible window.

The watchdog is a separate process, not an immortal one: killed by hand, OOM,
a logoff, and the promise "a crash is restarted" quietly lapses with nobody
noticing. The plugin therefore re-checks `watchdog.pid` every `watchdogCheckMs`
and arms a replacement, adopting a live one instead of duplicating it.

That re-arm has a sharp edge, and a live test found it. The watchdog used to be
armed only while its dsh was alive, so it always entered the "observe the parent"
branch, which is where the quit markers are honoured. A re-arm can instead land in
the very millisecond of a Quit: the parent is already gone, the observe branch is
skipped entirely, and nothing looked at the marker — a dsh the user had just quit
came back a second later. The watchdog now checks the markers before entering its
restart loop too, and ignores a marker older than the guarded instance (the plugin
deletes both markers at mount, so an older one describes a previous life — without
that guard, a dsh that crashed before its plugin mounted would inherit the last
quit's marker and never restart). `test/watchdog-standdown.test.mjs` covers both.

All profile-patch editing goes through one helper, `bin/patch-guard.mjs`. The
installer and uninstaller used to carry separate copies of that string surgery and
both were wrong differently, so a profile accumulated duplicate comment blocks and
orphaned `- insert:` entries. One implementation, covered by tests.

Honest limits: the plugin shares fate with the process it guards, so a safety-net
scheduled task (installed by the installer) is what brings the watchdog back if
both die; that task only runs while you are logged in, and the Windows
Application-log forensics needs `pwsh`.

The safety-net task is **silent**. A Scheduled Task whose action is
`powershell.exe` is a console program, so Windows shows a black window on every
tick — every two minutes, forever, which is exactly the kind of interruption this
tool is supposed to prevent. The action is `wscript.exe //B //Nologo
guard-autostart.vbs` instead: wscript has no console, and it starts PowerShell with
a hidden window. The installer generates that `.vbs` under `<DshHome>\guard\`.
