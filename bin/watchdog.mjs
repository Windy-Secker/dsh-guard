#!/usr/bin/env node
/**
 * dsh-guard watchdog — the process that is NOT dsh.
 *
 * Started detached by the dsh-guard plugin with the state directory, the pid of
 * the dsh it should guard, and the restart policy. It then:
 *
 *   - spawns dsh (`process.execPath` + the recorded argv) with stdout/stderr
 *     appended to `state/dsh.log`, so a crash leaves a log even when dsh itself
 *     never got the chance to write one;
 *   - waits for it to exit;
 *   - reads the verdict: the plugin's `clean-exit.json` marker (the Quit button)
 *     means stop; anything else means restart after a backoff;
 *   - halts when the same crash repeats past the policy, so an unfixable
 *     configuration cannot spin forever burning tokens;
 *   - records the reason for every death — exit code, how it exited, the Windows
 *     Application-log signature when Windows recorded one, and the tail of the
 *     crash log;
 *   - when `autoResume` is on and a task was interrupted, drops
 *     `resume-request.json` next to the snapshot, which the freshly started dsh
 *     picks up and delivers into the same session.
 *
 * Standalone by design: no imports from the dsh installation, only node builtins.
 * Run it by hand for a foreground session:
 *
 *   node bin/watchdog.mjs --state-dir ~/.dsh/guard --foreground
 *
 * @module dsh-guard/watchdog
 */

import { spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * Parse the watchdog command line.
 * @param argv - arguments after the node binary and script.
 * @returns the resolved options.
 */
export function parseArgs(argv) {
	const options = {
		stateDir: resolve(join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "guard")),
		parentPid: null,
		delayMs: 1500,
		maxRestarts: 10,
		windowMs: 600000,
		portConflict: DEFAULT_PORT_CONFLICT,
		/** A replacement that dies faster than this counts as an "immediate" crash. */
		rapidDeathMs: 3000,
		/** How many immediate crashes in a row end supervision instead of retrying. */
		maxRapidRestarts: 3,
		foreground: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		const next = () => argv[(index += 1)];
		switch (token) {
			case "--state-dir":
				options.stateDir = resolve(String(next()));
				break;
			case "--parent-pid":
				options.parentPid = Number(next());
				break;
			case "--delay-ms":
				options.delayMs = Number(next());
				break;
			case "--max-restarts":
				options.maxRestarts = Number(next());
				break;
			case "--window-ms":
				options.windowMs = Number(next());
				break;
			case "--port-conflict":
				options.portConflict = String(next()) === "replace" ? "replace" : DEFAULT_PORT_CONFLICT;
				break;
			case "--rapid-death-ms": {
				const value = Number(next());
				if (Number.isFinite(value) && value >= 0) options.rapidDeathMs = value;
				break;
			}
			case "--max-rapid-restarts": {
				const value = Number(next());
				if (Number.isFinite(value) && value >= 0) options.maxRapidRestarts = value;
				break;
			}
			case "--foreground":
				options.foreground = true;
				break;
			default:
				break;
		}
	}
	return options;
}

// ---------------------------------------------------------------------------
// Tiny file helpers (no dsh imports: this file must run on its own)
// ---------------------------------------------------------------------------

/** Read and parse JSON, or undefined. */
function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Durable JSON write: temp file plus rename, so a reader never sees a torn file. */
function writeJson(path, value) {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const temp = `${path}.tmp-${String(process.pid)}`;
		writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		renameSync(temp, path);
		return true;
	} catch {
		return false;
	}
}

/** True while `pid` names a live process. */
export function isAlive(pid) {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

/** One ISO timestamp. */
function now() {
	return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Crash forensics
// ---------------------------------------------------------------------------

/**
 * Ask the Windows Application log what it recorded around `sinceMs`. This is the
 * only place a truly silent death (OOM, access violation, a native addon
 * aborting) leaves a trace that is not a Node exit code.
 * @param sinceMs - epoch milliseconds to search from.
 * @returns matched event summaries, or an empty list on any failure.
 */
export function windowsFatalEvents(sinceMs) {
	if (process.platform !== "win32") return [];
	const since = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/u, "Z");
	const script = [
		`$start = [datetime]::Parse('${since}').ToLocalTime()`,
		"$events = Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=$start; Level=1,2} -MaxEvents 40 -ErrorAction SilentlyContinue",
		"if ($null -eq $events) { exit 0 }",
		"$events | Where-Object { $_.ProviderName -match 'Application Error|Windows Error Reporting|.NET Runtime' } |",
		"  Select-Object -First 6 | ForEach-Object { '{0}|{1}|{2}' -f $_.TimeCreated.ToString('o'), $_.ProviderName, (($_.Message -split \"`n\")[0..2] -join ' ') }",
	].join("\n");
	try {
		const result = spawnSync(
			"pwsh",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ encoding: "utf8", timeout: 8000, windowsHide: true },
		);
		if (result.status !== 0 && result.stdout.trim() === "") return [];
		return result.stdout
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter((line) => line !== "")
			.map((line) => {
				const [at, provider, ...rest] = line.split("|");
				return { at, provider, message: rest.join("|").slice(0, 500) };
			});
	} catch {
		return [];
	}
}

/** Last `limit` lines of a text file. */
export function tail(path, limit) {
	try {
		const lines = readFileSync(path, "utf8").split(/\r?\n/u);
		return lines.slice(-limit);
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

/** Marker written by the Quit button's graceful shutdown. */
const CLEAN_EXIT = "clean-exit.json";
/** Marker written by the Quit button; the watchdog stops even if `clean-exit` is lost. */
const STOP = "stop.json";
/** What the plugin writes on boot: how to relaunch this dsh. */
const INSTANCE = "instance.json";
/** Written for the next dsh start when a restart should continue the task. */
const RESUME_REQUEST = "resume-request.json";
/** The task snapshot the plugin maintains. */
const SNAPSHOT = "snapshot.json";
/** One line per death, appended by both the plugin and this process. */
const CRASH_LOG = "crashes.log";
/** The watchdog's own log. */
const WATCHDOG_LOG = "watchdog.log";
/** dsh's stdout/stderr on every supervised start. */
const DSH_LOG = "dsh.log";
/** This watchdog's pid file, for `guard-status` and the autostart task. */
const WATCHDOG_PID = "watchdog.pid";
/** Crash reports this watchdog produced. */
const CRASH_REPORT = "watchdog-crash.json";
/** The plugin's status route; probing it is how "is our dsh still serving?" is answered. */
const STATUS_ROUTE = "/dsh-guard/status";
/** Written when supervision stops for a reason a human must act on. */
const HALT = "watchdog-halt.json";
/** What to do when the recorded port is already taken by a foreign process. */
const DEFAULT_PORT_CONFLICT = "halt";

/**
 * Read the relaunch recipe the plugin recorded.
 * @param stateDir - the state directory.
 * @returns `{ execPath, args, cwd }`, or undefined when unusable.
 */
export function readInvocation(stateDir) {
	const instance = readJson(join(stateDir, INSTANCE));
	if (instance === undefined || typeof instance !== "object") return undefined;
	if (typeof instance.execPath !== "string" || !Array.isArray(instance.args) || instance.args.length === 0) return undefined;
	const entry = instance.args[0];
	if (typeof entry !== "string" || !existsSync(entry)) return undefined;
	return {
		execPath: instance.execPath,
		args: instance.args.map(String),
		cwd: typeof instance.cwd === "string" && existsSync(instance.cwd) ? instance.cwd : process.cwd(),
		autoResume: instance.options?.autoResume === true,
		port: typeof instance.port === "number" ? instance.port : null,
	};
}

/**
 * Can this process bind `port` on loopback right now?
 *
 * This is the precondition that matters before spawning a replacement dsh: a dsh
 * whose port is already taken dies at boot with EADDRINUSE, and restarting it
 * anyway turns one crash into an endless spawn loop of doomed processes. Binding
 * is the honest test — `connect` only proves something is listening, while bind
 * proves a listener would actually be accepted.
 * @param port - the port the recorded dsh invocation uses.
 * @param timeoutMs - how long to wait for the bind result.
 * @returns true when the port is free (or when no port is known).
 */
export function portBindable(port, timeoutMs = 1200) {
	return new Promise((resolvePromise) => {
		if (typeof port !== "number" || port <= 0) {
			resolvePromise(true);
			return;
		}
		const server = createServer();
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			try {
				server.close();
			} catch {
				/* never listened */
			}
			resolvePromise(value);
		};
		server.once("error", () => finish(false));
		server.once("listening", () => finish(true));
		const timer = setTimeout(() => finish(false), timeoutMs);
		timer.unref?.();
		try {
			server.listen(port, "127.0.0.1");
		} catch {
			finish(false);
		}
	});
}

/** Does anything still answer on the recorded port? */
export function portAnswers(port, timeoutMs = 700) {
	return new Promise((resolvePromise) => {
		if (typeof port !== "number" || port <= 0) {
			resolvePromise(false);
			return;
		}
		const socket = createConnection({ host: "127.0.0.1", port });
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolvePromise(value);
		};
		socket.setTimeout(timeoutMs, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

/**
 * Ask the dsh-guard status route on `port` who is serving it.
 *
 * A matching `pid` means the very dsh this watchdog records is still alive and
 * serving — which happens when the plugin was mounted into an already-running
 * dsh (a live profile reload). Streaming to /dev/null still pops the watchdog
 * when the plugin's install-time `queueMicrotask` fires, so without this check
 * the watchdog would restart a dsh that never died.
 * @param port - the recorded port.
 * @param timeoutMs - HTTP timeout.
 * @returns the parsed status body, or undefined when nothing guard-shaped answers.
 */
export async function readGuardStatus(port, timeoutMs = 1500) {
	if (typeof port !== "number" || port <= 0) return undefined;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`http://127.0.0.1:${String(port)}${STATUS_ROUTE}`, {
			headers: { accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) return undefined;
		const body = await response.json();
		return typeof body === "object" && body !== null && body.ok === true ? body : undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Decide whether one death means "restart" and why.
 *
 * The clean-exit or stop marker is the ONLY way to say "this was intentional":
 * an exit code is not a promise, and `process.exit(0)` from any unrelated code
 * path still leaves work unfinished. So every other death is restarted, subject
 * to the caller's restart budget and its rapid-crash circuit breaker.
 *
 * There is deliberately no "parent is gone, so give up" clause here. In this
 * design the guarded dsh IS the child this watchdog spawns, so the moment that
 * child dies its pid is gone — that fact can never distinguish "the dsh I guard
 * crashed" from "I am an orphaned watchdog". Orphaned watchdogs are detected
 * where the information actually exists: the `parentWatch` timer (no supervision
 * under way and the recorded instance points at a different pid) and this loop's
 * port preflight (a live guard already serving the recorded port).
 * @param input - the facts about the death.
 * @returns the verdict.
 */
export function verdictFor(input) {
	const { cleanExit, stopRequested, exitCode, signal, supervising } = input;
	if (stopRequested !== undefined && stopRequested !== null) {
		return { restart: false, reason: "停止标记：用户在界面上正常退出" };
	}
	if (cleanExit !== undefined && cleanExit !== null) return { restart: false, reason: "正常退出（clean-exit 标记）" };
	if (supervising !== true) {
		// Only reachable if the loop is changed to consult the verdict before it has
		// spawned anything; there is then nothing to guard.
		return { restart: false, reason: "尚未开始守护，没有需要拉起的 dsh" };
	}
	if (exitCode === null && signal === null) return { restart: false, reason: "既无退出码也无信号，无法判断" };
	return { restart: true, reason: `异常终止（退出码 ${String(exitCode)}${signal ? `, 信号 ${String(signal)}` : ""}）` };
}

/**
 * Run the supervision loop. Never returns while supervision is active; call it
 * as the script body.
 * @param options - parsed watchdog arguments (see {@link parseArgs}).
 */
export async function runWatchdog(options) {
	const stateDir = options.stateDir;
	const logPath = join(stateDir, WATCHDOG_LOG);
	const log = (message) => {
		const line = `${now()}\t${message}`;
		try {
			mkdirSync(stateDir, { recursive: true });
			appendFileSync(logPath, `${line}\n`, "utf8");
		} catch {
			/* logging is best-effort */
		}
		if (options.foreground) process.stdout.write(`${line}\n`);
	};

	// A second watchdog for the same dsh state is a bug, not a feature: refuse and
	// leave the incumbent alone.
	const pidFile = join(stateDir, WATCHDOG_PID);
	const existing = readJson(pidFile);
	if (existing?.pid !== undefined && existing.pid !== process.pid && isAlive(existing.pid)) {
		log(`another watchdog (pid ${String(existing.pid)}) already guards ${stateDir}; exiting`);
		return;
	}
	writeJson(pidFile, { pid: process.pid, at: now(), stateDir });
	log(`watchdog pid ${String(process.pid)} guarding parent ${String(options.parentPid)}; state ${stateDir}`);

	const restarts = [];
	/** How long the last few replacements lived; a rapid streak halts supervision. */
	const rapidDeaths = [];
	/** True once a restart sequence is under way (see the verdictFor clause). */
	let supervising = false;
	let child = null;
	let stopping = false;

	const stop = (why) => {
		stopping = true;
		log(`stopping: ${why}`);
		if (child !== null && child.exitCode === null && !child.killed) {
			try {
				child.kill();
			} catch {
				/* already gone */
			}
		}
		rmSync(pidFile, { force: true });
		process.exit(0);
	};

	// Safety valve for a watchdog nobody will ever stop: when the guarded process
	// is gone, no restart is under way, and the recorded instance no longer points
	// at it, this watchdog is a leftover. An active supervision session is
	// deliberately exempt, because that is precisely the case it exists for.
	const parentWatch = setInterval(() => {
		if (stopping || supervising) return;
		if (options.parentPid === null || isAlive(options.parentPid)) return;
		if (readJson(join(stateDir, CLEAN_EXIT)) !== undefined) return stop("guarded dsh exited cleanly");
		const owner = readJson(join(stateDir, INSTANCE))?.pid;
		if (owner !== undefined && owner !== options.parentPid) return stop(`superseded by pid ${String(owner)}`);
	}, 5000);
	parentWatch.unref?.();

	for (;;) {
		const invocation = readInvocation(stateDir);
		if (invocation === undefined) {
			log(`no usable instance.json under ${stateDir} (missing execPath/args or the entry script is gone); cannot relaunch — stopping`);
			rmSync(pidFile, { force: true });
			return;
		}
		options.parentPid = readJson(join(stateDir, INSTANCE))?.pid ?? options.parentPid;

		// -- preflight: never spawn a dsh that cannot possibly bind --------------
		//
		// Without this the watchdog happily restarted a dsh that was still alive:
		// the plugin mounts into a running process on a live profile reload, its
		// spawn intent fires, and the replacement dies at boot with EADDRINUSE.
		// The restart loop then produced a new doomed process every few seconds.
		if (invocation.port !== null) {
			const serving = await readGuardStatus(invocation.port);
			const incumbentPid = options.parentPid ?? readJson(join(stateDir, INSTANCE))?.pid ?? null;
			if (serving !== undefined) {
				if (serving.pid === incumbentPid) {
					log(
						`pid ${String(serving.pid)} is already serving ${String(invocation.port)} with a live guard; nothing to restart — standing down`,
					);
					rmSync(pidFile, { force: true });
					rmSync(join(stateDir, HALT), { force: true });
					return;
				}
				log(
					`port ${String(invocation.port)} is served by guard pid ${String(serving.pid)}, not the guarded pid ${String(incumbentPid)}`,
				);
			}
			if (!(await portBindable(invocation.port))) {
				const halt = {
					schema: "dsh-guard/watchdog-halt@1",
					at: now(),
					reason: "port-conflict",
					detail: `127.0.0.1:${String(invocation.port)} is already in use by a process this watchdog does not own`,
					guardedPid: incumbentPid,
					servingGuardPid: serving?.pid ?? null,
					invocation: { execPath: invocation.execPath, args: invocation.args, cwd: invocation.cwd },
					advice: [
						"another dsh (or another program) holds the port; restarting here would only produce EADDRINUSE",
						"free the port, then start dsh again — the plugin starts a fresh watchdog on boot",
						"or run the watchdog with --port-conflict replace if you want it to kill the holder",
					],
				};
				writeJson(join(stateDir, HALT), halt);
				appendFileSync(
					join(stateDir, CRASH_LOG),
					`${now()}\twatchdog\t端口冲突，停止拉起\tport=${String(invocation.port)} holder=${String(serving?.pid ?? "unknown")}\n`,
					"utf8",
				);
				if (options.portConflict === "replace") {
					const victim = serving?.pid ?? null;
					log(`--port-conflict replace: stopping holder ${String(victim)} on port ${String(invocation.port)}`);
					if (typeof victim === "number" && victim > 0) {
						try {
							process.kill(victim);
						} catch (error) {
							log(`could not stop holder ${String(victim)}: ${String(error?.message ?? error)}`);
						}
						// Give the OS a moment to release the listener before retrying.
						await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));
					}
					if (!(await portBindable(invocation.port))) {
						log("port still not bindable after --port-conflict replace; halting supervision");
						rmSync(pidFile, { force: true });
						return;
					}
				} else {
					log(
						`halting supervision: port ${String(invocation.port)} is taken; see ${join(stateDir, HALT)} (pass --port-conflict replace to take it over)`,
					);
					rmSync(pidFile, { force: true });
					return;
				}
			}
		}

		// Clear stale markers so this run's verdict cannot be inherited.
		rmSync(join(stateDir, CLEAN_EXIT), { force: true });
		const startedAt = Date.now();
		const dshLog = join(stateDir, DSH_LOG);
		let out = "ignore";
		try {
			out = openSync(dshLog, "a");
		} catch {
			out = "ignore";
		}
		log(`starting dsh: ${invocation.execPath} ${invocation.args.join(" ")} (cwd ${invocation.cwd})`);
		appendFileSync(dshLog, `\n===== dsh-guard: start ${now()} =====\n`, "utf8");
		child = spawn(invocation.execPath, invocation.args, {
			cwd: invocation.cwd,
			env: process.env,
			stdio: ["ignore", out, out],
			windowsHide: false,
		});
		if (out !== "ignore") {
			try {
				closeSync(out);
			} catch {
				/* the child owns the descriptor now */
			}
		}
		child.on("error", (error) => log(`child spawn error: ${String(error?.message ?? error)}`));
		const spawnFailed = await new Promise((resolvePromise) => {
			child.once("spawn", () => resolvePromise(false));
			child.once("error", () => resolvePromise(true));
		});
		if (spawnFailed) {
			log("spawn failed; retrying after the delay");
		}
		// Having started a process IS supervising it: from here on, this child's
		// death is the failure to repair, never evidence that the guardian is
		// orphaned. The orphan check only applies before the first spawn, when the
		// parent pid we were handed may name a dsh that is already gone.
		const deathWasRestart = supervising;
		supervising = true;
		// Guard against a regression that silently changes which value the verdict
		// reads: assigning above must be the binding used below.
		if (supervising !== true) throw new Error("dsh-guard: internal invariant violated — supervising was reset after spawn");

		const { code, signal } = await new Promise((resolvePromise) => {
			child.once("exit", (exitCode, exitSignal) => resolvePromise({ code: exitCode, signal: exitSignal }));
		});
		const livedMs = Date.now() - startedAt;
		child = null;

		const cleanExit = readJson(join(stateDir, CLEAN_EXIT));
		const stopRequested = readJson(join(stateDir, STOP));
		const verdict = verdictFor({
			cleanExit,
			stopRequested,
			exitCode: code,
			signal: signal ?? null,
			supervising,
		});

		// Crash forensics: what did the OS record, and what did the plugin record?
		const pluginCrash = readJson(join(stateDir, "crash.json"));
		const recent = pluginCrash !== undefined && pluginCrash !== null && Date.parse(pluginCrash.at) >= startedAt - 2000 ? pluginCrash : null;
		const windowsEvents = verdict.restart ? windowsFatalEvents(startedAt) : [];
		const report = {
			schema: "dsh-guard/watchdog-crash@1",
			at: now(),
			reason: verdict.reason,
			restart: verdict.restart,
			exitCode: code,
			signal: signal ?? null,
			livedMs,
			pluginCrash: recent,
			windowsEvents,
			dshLogTail: tail(dshLog, 40),
			crashLogTail: tail(join(stateDir, CRASH_LOG), 20),
			invocation: { execPath: invocation.execPath, args: invocation.args, cwd: invocation.cwd },
		};
		writeJson(join(stateDir, CRASH_REPORT), report);
		appendFileSync(
			join(stateDir, CRASH_LOG),
			`${now()}\twatchdog\t${verdict.reason}\texit=${String(code)} signal=${String(signal)} livedMs=${String(livedMs)}\n`,
			"utf8",
		);
		log(
			`dsh exited: code=${String(code)} signal=${String(signal)} lived=${String(livedMs)}ms → ${verdict.restart ? "restart" : "no restart"} (${verdict.reason})`,
		);
		if (windowsEvents.length > 0) {
			log(`windows application log: ${windowsEvents.map((event) => `${String(event.provider)}@${String(event.at)}`).join(", ")}`);
		}

		if (!verdict.restart) {
			rmSync(pidFile, { force: true });
			return;
		}

		// Circuit breaker for failures that restarting provably cannot fix.
		//
		// A replacement dsh that died on EADDRINUSE means the port is held by
		// someone else, so spawning another would just repeat the mistake. More
		// generally, a replacement that dies almost immediately, several times in a
		// row, is not a transient crash: something about this invocation fails at
		// boot every time, and grinding through the full restart budget only spawns
		// doomed processes and loses the diagnostics in the noise.
		const sawAddrInUse = report.dshLogTail.some((line) => line.includes("EADDRINUSE"));
		// Only a REPLACEMENT dying instantly counts toward the streak: the first
		// process was the guarded dsh doing its normal work, and one quick death
		// there still deserves exactly one restart attempt.
		if (deathWasRestart) rapidDeaths.push(livedMs);
		if (rapidDeaths.length > 8) rapidDeaths.shift();
		const rapidLimit = Math.max(options.maxRapidRestarts, 1);
		const rapidStreak =
			rapidDeaths.length >= rapidLimit && rapidDeaths.slice(-rapidLimit).every((ms) => ms <= options.rapidDeathMs);
		if (sawAddrInUse || rapidStreak) {
			const halt = {
				schema: "dsh-guard/watchdog-halt@1",
				at: now(),
				reason: sawAddrInUse ? "eaddrinuse" : "rapid-crash-loop",
				detail: sawAddrInUse
					? `the replacement dsh could not bind 127.0.0.1:${String(invocation.port ?? "?")}: address already in use`
					: `${String(rapidDeaths.length)} consecutive restarts each died within ${String(options.rapidDeathMs)}ms (${rapidDeaths.join(", ")}ms) — restarting again would only repeat it`,
				exitCode: code,
				livedMs,
				invocation: { execPath: invocation.execPath, args: invocation.args, cwd: invocation.cwd },
				dshLogTail: report.dshLogTail.slice(-12),
				advice: [
					"the invocation itself is failing at boot; read dsh.log for the real error",
					"free the port (or fix the flag/config) and start dsh again — the plugin starts a fresh watchdog on boot",
					sawAddrInUse
						? "if the holder is a stray dsh of the same profile, stop that process"
						: "restarting will not help until the boot error is fixed",
				],
			};
			writeJson(join(stateDir, HALT), halt);
			log(
				sawAddrInUse
					? `halting supervision: EADDRINUSE on port ${String(invocation.port ?? "?")}`
					: `halting supervision: ${String(rapidDeaths.length)} consecutive immediate crashes (${rapidDeaths.join("/")}ms) — not restarting again`,
			);
			rmSync(pidFile, { force: true });
			return;
		}

		// Restart policy: too many deaths inside one window, or a crash loop right
		// after boot, halts supervision instead of burning the account.
		const cut = Date.now() - options.windowMs;
		while (restarts.length > 0 && restarts[0] < cut) restarts.shift();
		restarts.push(Date.now());
		if (options.maxRestarts > 0 && restarts.length > options.maxRestarts) {
			log(`restart budget exhausted (${String(restarts.length - 1)} in ${String(options.windowMs)}ms); halting supervision`);
			rmSync(pidFile, { force: true });
			return;
		}

		const backoff = livedMs < 15000 ? Math.min(options.delayMs * 4, 20000) : options.delayMs;
		if (invocation.autoResume) {
			const snapshot = readJson(join(stateDir, SNAPSHOT));
			if (snapshot !== undefined && snapshot !== null && snapshot.interrupted === true) {
				writeJson(join(stateDir, RESUME_REQUEST), {
					schema: "dsh-guard/resume-request@1",
					at: now(),
					sessionId: snapshot.sessionId ?? null,
					cwd: snapshot.cwd ?? null,
					snapshotPath: join(stateDir, SNAPSHOT),
					reason: verdict.reason,
				});
				log(`autoResume: wrote resume-request.json for session ${String(snapshot.sessionId ?? "?")}`);
			}
		}
		log(`waiting ${String(backoff)}ms before restart ${String(restarts.length)}`);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, backoff));
		if (stopping) return;
	}
}

const invokedPath = process.argv[1];
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href;
if (isMain || process.env.DSH_GUARD_WATCHDOG_FORCE === "1") {
	await runWatchdog(parseArgs(process.argv.slice(2)));
}
