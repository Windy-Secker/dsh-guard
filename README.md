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
| `tailEvents` | `40` | recent events kept in the snapshot |
| `timeoutMs` | `4000` | graceful-shutdown backstop |
| `keepSessions` | `12` | per-session snapshots retained |

Giving up is loud, not silent: the reason lands in `watchdog-halt.json`
(`rapid-crash-loop`, `port-conflict`, `eaddrinuse`) together with the tail of the
failed dsh's output, so a boot loop leaves a diagnosis rather than a pile of
orphan processes.

Tests: `node test/snapshot.test.mjs`, `node test/watchdog-policy.test.mjs`,
`node test/check-patch.mjs <patch>`, or `.\install-guard.ps1 -Test` for those
three. `node test/quit-e2e.mjs` additionally boots a throwaway dsh in an isolated
`DSH_HOME` and proves the whole Quit path: status route, quit accepted,
`clean-exit.json` written, exit code 0, watchdog stands down.

Honest limits: the plugin shares fate with the process it guards, so a safety-net
scheduled task (installed by the installer) is what brings the watchdog back if
both die; that task only runs while you are logged in, and the Windows
Application-log forensics needs `pwsh`.
