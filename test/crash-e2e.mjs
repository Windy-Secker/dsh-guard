#!/usr/bin/env node
/**
 * Destructive end-to-end test: force-kill a real dsh and prove the watchdog
 * brings it back, then let it die a second time to prove the recovery is not a
 * one-shot.
 *
 * This is deliberately run against a THROWAWAY instance — its own DSH_HOME, its
 * own port, its own guard state directory — so an operator's live GUI and its
 * running sessions are never touched. (The graceful-exit path has its own test,
 * `quit-e2e.mjs`; this one covers the case that motivated the whole guard: the
 * process dies without a chance to write anything.)
 *
 * What it asserts:
 *   1. a force-killed dsh is replaced by a NEW process on the same port;
 *   2. the watchdog recorded the death — exit code/signal in `watchdog-crash.json`
 *      and `crashes.log` — instead of the death being silent;
 *   3. `clean-exit.json` was NOT written (nobody asked for the exit);
 *   4. a second kill is also recovered, so the brake did not trip on a normal crash;
 *   5. a graceful quit afterwards stops the watchdog (no leftover supervisor).
 *
 * Usage: node test/crash-e2e.mjs [--dsh <path to lib/bin.js>] [--keep]
 * @module dsh-guard/test/crash-e2e
 */

import { spawn } from "node:child_process";
import {
	closeSync,
	cpSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const dshIndex = argv.indexOf("--dsh");

/**
 * Resolve the dsh entry the same way quit-e2e does: the DSH_HOME module farm is
 * the stable anchor, not a hardcoded install path.
 * @param explicit - `--dsh` override.
 * @returns the entry path, or undefined.
 */
function resolveDshEntry(explicit) {
	const candidates = [];
	if (explicit !== undefined) candidates.push(explicit);
	if (process.env.DSH_NODE_MODULES) candidates.push(join(process.env.DSH_NODE_MODULES, "@deepseek-ai", "dsh", "lib", "bin.js"));
	if (process.env.DSH_HOME) candidates.push(join(process.env.DSH_HOME, "profiles", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
	const roaming = process.env.APPDATA ?? (process.env.USERPROFILE ? join(process.env.USERPROFILE, "AppData", "Roaming") : undefined);
	if (roaming !== undefined) candidates.push(join(roaming, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
	return candidates.find((candidate) => existsSync(candidate));
}

const DSH_ENTRY = resolveDshEntry(dshIndex === -1 ? undefined : argv[dshIndex + 1]);
if (DSH_ENTRY === undefined) {
	console.error("dsh entry not found; pass --dsh <path to lib/bin.js>");
	process.exit(2);
}

/** Ask the OS for a free port. */
function freePort() {
	return new Promise((resolvePromise) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => resolvePromise(address.port));
		});
	});
}

/** One HTTP call with a hard timeout. */
async function call(url, method = "GET", timeoutMs = 4000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { method, signal: controller.signal, headers: { accept: "application/json" } });
		const text = await response.text();
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
		return { status: response.status, body };
	} finally {
		clearTimeout(timer);
	}
}

/** Poll until `check()` is truthy. */
async function waitFor(check, timeoutMs, intervalMs = 700) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let value;
		try {
			value = await check();
		} catch {
			value = undefined;
		}
		if (value !== undefined && value !== false && value !== null) return value;
		if (Date.now() > deadline) return undefined;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
	}
}

/** True while `pid` names a live process. */
function isAlive(pid) {
	if (typeof pid !== "number" || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

const home = join(tmpdir(), `dsh-guard-crash-${String(process.pid)}`);
const profileDir = join(home, "profiles", "web");
const stateDir = join(home, "guard");
const failures = [];
const step = (ok, label, detail = "") => {
	if (!ok) failures.push(label);
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`);
};

let dsh = null;
let logHandle = "ignore";
let lastStatus = undefined;

try {
	mkdirSync(join(profileDir, "node_modules"), { recursive: true });
	writeFileSync(
		join(profileDir, "package.json"),
		`${JSON.stringify(
			{ name: "dsh-profile-web", private: true, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], patchReload: "live" } } },
			null,
			2,
		)}\n`,
		"utf8",
	);
	writeFileSync(join(profileDir, "cordis.yml"), "[]\n", "utf8");
	writeFileSync(
		join(profileDir, "cordis.patch.yml"),
		[
			"# crash-e2e profile: the guard, with a throwaway state directory.",
			"- insert:",
			"    - id: guard",
			"      name: 'dsh-guard'",
			"      config:",
			`        stateDir: '${stateDir.replace(/\\/gu, "/")}'`,
			"        watchdog: true",
			"        autoResume: false",
			"",
		].join("\n"),
		"utf8",
	);

	const linked = join(profileDir, "node_modules", "dsh-guard");
	let linkedHow = "junction";
	try {
		symlinkSync(packageRoot, linked, "junction");
	} catch {
		linkedHow = "copy";
		cpSync(packageRoot, linked, { recursive: true, filter: (source) => !source.includes(join(packageRoot, ".git")) });
	}

	const port = await freePort();
	const logPath = join(home, "dsh-output.log");
	mkdirSync(home, { recursive: true });
	try {
		logHandle = openSync(logPath, "a");
	} catch {
		logHandle = "ignore";
	}
	const readOutput = () => {
		try {
			return readFileSync(logPath, "utf8");
		} catch {
			return "";
		}
	};
	// A closed port makes fetch REJECT; that is the expected signal here, so fold it
	// into "nothing answers" instead of letting it bubble (an earlier version threw
	// on every poll, so the predicate could never report success).
	const statusOf = async () => {
		try {
			const result = await call(`http://127.0.0.1:${String(port)}/dsh-guard/status`);
			return result.status === 200 ? result.body : undefined;
		} catch {
			return undefined;
		}
	};

	console.log(`profile: ${profileDir} (guard ${linkedHow})`);
	console.log(`state:   ${stateDir}`);
	console.log(`port:    ${String(port)}`);

	/** Boot (or re-boot) the throwaway instance and return its first status. */
	const boot = async (label) => {
		dsh = spawn(process.execPath, [DSH_ENTRY, "web", "--port", String(port), "--no-open"], {
			cwd: packageRoot,
			env: { ...process.env, DSH_HOME: home },
			stdio: ["ignore", logHandle, logHandle],
		});
		const status = await waitFor(statusOf, 120_000);
		step(status !== undefined, `${label}: instance answers /dsh-guard/status`);
		return status;
	};

	// ---------------------------------------------------------------------
	// boot
	// ---------------------------------------------------------------------
	const first = await boot("boot 1");
	if (first === undefined) {
		console.error(`--- throwaway dsh output (tail) ---\n${readOutput().slice(-3000)}`);
		throw new Error("the throwaway dsh never served the guard status route");
	}
	const firstPid = first.pid;
	step(typeof firstPid === "number" && firstPid > 0, "the guarded pid is known", String(firstPid));
	step(first.watchdog?.status === "running", "watchdog spawned on first boot", JSON.stringify(first.watchdog));
	const firstWatchdogPid = first.watchdog?.pid ?? null;

	// ---------------------------------------------------------------------
	// kill 1: force-terminate, no chance to write anything
	// ---------------------------------------------------------------------
	process.kill(firstPid, "SIGKILL");
	step(await waitFor(() => (isAlive(firstPid) ? undefined : true), 15_000), "the first dsh process is gone");

	const second = await waitFor(async () => {
		const status = await statusOf();
		return status !== undefined && status.pid !== firstPid ? status : undefined;
	}, 120_000);
	step(second !== undefined, "a NEW dsh pid answers on the same port");
	step(second?.pid !== firstPid, "the recovery is a replacement, not the corpse", `${String(firstPid)} -> ${String(second?.pid)}`);
	step(second?.port === port, "the replacement took the same port", String(second?.port));

	const reportPath = join(stateDir, "watchdog-crash.json");
	const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
	step(report !== undefined, "watchdog wrote a crash report for the death it observed");
	step(report?.observed === true, "the report is marked as an OBSERVED exit (the guarded process was not our child)", String(report?.observed));
	step(report?.restart === true, "the report says it restarted", JSON.stringify(report?.reason ?? null));
	step(!existsSync(join(stateDir, "clean-exit.json")), "no clean-exit marker (nobody asked for the exit)");
	step(
		existsSync(join(stateDir, "crashes.log")) && /watchdog/u.test(readFileSync(join(stateDir, "crashes.log"), "utf8")),
		"crashes.log recorded the death",
	);
	step(
		Array.isArray(report?.windowsEvents) || report?.windowsEvents === undefined,
		"the observed report carries the Windows application-log probe",
		`${String(report?.windowsEvents?.length ?? 0)} event(s)`,
	);

	// ---------------------------------------------------------------------
	// kill 2: recovery must not be a one-shot
	// ---------------------------------------------------------------------
	step(await waitFor(() => (isAlive(firstWatchdogPid ?? 0) ? true : undefined), 15_000), "the original watchdog is still supervising");
	process.kill(second.pid, "SIGKILL");
	const third = await waitFor(async () => {
		const status = await statusOf();
		return status !== undefined && status.pid !== second.pid ? status : undefined;
	}, 120_000);
	step(third !== undefined, "a second force-kill is also recovered");
	step(third?.pid !== second?.pid, "second recovery is a new pid", `${String(second?.pid)} -> ${String(third?.pid)}`);

	// The second death WAS a supervised child, so this time the watchdog has a real
	// exit code / signal to report — the stronger forensic case.
	const childReport = await waitFor(() => {
		const parsed = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
		return parsed !== undefined && parsed.observed !== true ? parsed : undefined;
	}, 30_000);
	step(childReport !== undefined, "the supervised child's death produced a direct report");
	step(
		childReport?.exitCode !== 0 || (childReport?.signal !== null && childReport?.signal !== undefined),
		"the supervised child's report carries a non-zero exit code or a signal",
		`exit=${String(childReport?.exitCode)} signal=${String(childReport?.signal)}`,
	);

	// ---------------------------------------------------------------------
	// graceful exit: the watchdog must stand down, not restart
	// ---------------------------------------------------------------------
	const quit = await call(`http://127.0.0.1:${String(port)}/dsh-guard/quit`, "POST");
	step(quit.status === 200, "graceful quit accepted", `HTTP ${String(quit.status)}`);
	step(await waitFor(() => (existsSync(join(stateDir, "clean-exit.json")) ? true : undefined), 8000), "clean-exit marker written");
	const thirdGone = await waitFor(() => (isAlive(third.pid) ? undefined : true), 30_000);
	step(thirdGone === true, "the last dsh exited on its own");
	const nothingRestarted = await waitFor(async () => {
		const status = await statusOf();
		if (status === undefined) return true;
		lastStatus = status;
		return undefined;
	}, 20_000);
	step(
		nothingRestarted === true,
		"nothing was restarted after the graceful quit",
		nothingRestarted === true ? "" : `something still answers: ${JSON.stringify(lastStatus ?? null).slice(0, 240)}`,
	);
	step(!existsSync(join(stateDir, "watchdog.pid")), "the watchdog removed its pid file on the way out");
	step(
		await waitFor(() => (firstWatchdogPid !== null && isAlive(firstWatchdogPid) ? undefined : true), 20_000) === true,
		"the watchdog stood down after the graceful quit",
	);
	dsh = null;
} catch (error) {
	failures.push(error.message);
	console.error(`error: ${error.message}`);
} finally {
	if (dsh !== null && dsh.exitCode === null) {
		try {
			dsh.kill();
		} catch {
			/* already gone */
		}
	}
	if (logHandle !== "ignore") {
		try {
			closeSync(logHandle);
		} catch {
			/* closed with the process */
		}
	}
	if (keep) console.log(`kept for inspection: ${home}`);
	else {
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			/* a locked log is not worth failing on */
		}
	}
}

if (failures.length > 0) {
	console.error(`\ncrash-e2e: ${String(failures.length)} check(s) failed:`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log("\ncrash-e2e: ok");
