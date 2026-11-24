#!/usr/bin/env node
/**
 * A watchdog that starts at a moment when the guarded dsh is ALREADY gone must
 * still honour the quit markers.
 *
 * Why this exists: the plugin only used to arm a watchdog while its own dsh was
 * alive, so the watchdog always entered its observe loop and saw the clean-exit
 * marker there. Now the plugin also re-arms a watchdog that died, and that
 * re-arm can land in the very same millisecond as a Quit ??at which point the
 * parent is already gone, the observe loop is skipped entirely, and nothing
 * looked at the marker. The result was a dsh the user had just quit coming back
 * from the dead a second later.
 *
 * Runs with `node test/watchdog-standdown.test.mjs`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const watchdogPath = join(packageRoot, "bin", "watchdog.mjs");

const failures = [];
const step = (ok, label, detail = "") => {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` ??${detail}`}`);
	if (!ok) failures.push(label);
};

/** Poll until `check()` is truthy or the deadline passes. */
async function waitFor(check, timeoutMs, intervalMs = 250) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await check();
		if (value) return value;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
	}
	return undefined;
}

/** A pid that is certainly dead: spawn something trivial and wait for it. */
async function deadPid() {
	const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
	await new Promise((resolvePromise) => child.once("exit", resolvePromise));
	return child.pid;
}

/**
 * Build one throwaway state directory.
 * @param parentPid - the (dead) pid the watchdog is told to guard.
 * @param startedAt - ISO start of the guarded instance.
 * @returns paths the test needs.
 */
function makeScene(parentPid, startedAt) {
	const root = mkdtempSync(join(tmpdir(), "dsh-guard-standdown-"));
	const stateDir = join(root, "guard");
	mkdirSync(stateDir, { recursive: true });
	const fakeDsh = join(root, "fake-dsh.mjs");
	const startedFile = join(root, "started.txt");
	writeFileSync(fakeDsh, 'import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2], "started\\n");\n', "utf8");
	// The watchdog refuses to relaunch an instance whose entry script is gone, so
	// the fake dsh has to exist; it records the relaunch and exits cleanly.
	writeFileSync(
		join(stateDir, "instance.json"),
		`${JSON.stringify(
			{
				schema: "dsh-guard/instance@1",
				pid: parentPid,
				port: null,
				cwd: root,
				execPath: process.execPath,
				args: [fakeDsh, startedFile],
				startedAt,
				updatedAt: startedAt,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	return {
		root,
		stateDir,
		startedFile,
		readLog: () => {
			try {
				return readFileSync(join(stateDir, "watchdog.log"), "utf8");
			} catch {
				return "";
			}
		},
	};
}

/** Run the real watchdog against a scene and wait for it to exit (or time out). */
function runWatchdog(scene, parentPid) {
	const child = spawn(
		process.execPath,
		[
			watchdogPath,
			"--state-dir",
			scene.stateDir,
			"--parent-pid",
			String(parentPid ?? 0),
			"--delay-ms",
			"200",
			// Hidden: this test must never flash a console window at whoever runs it.
			"--restart-window",
			"hidden",
		],
		{ cwd: packageRoot, stdio: "ignore" },
	);
	const exited = new Promise((resolvePromise) => child.once("exit", (code, signal) => resolvePromise({ code, signal })));
	return { child, exited };
}

/**
 * Tear a scene down. Cleanup must never fail the test: a watchdog that was just
 * killed can still hold handles in its state directory for a moment (PowerShell
 * and the console host it started are separate processes), and Windows then
 * refuses the removal with EPERM.
 */
async function dispose(scene, child) {
	try {
		child?.kill();
	} catch {
		/* already gone */
	}
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
	try {
		rmSync(scene.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch {
		/* a locked temp directory is not worth a red test */
	}
}

// --- case A: a quit marker written for THIS life means "stay down" -----------
{
	const parentPid = await deadPid();
	const startedAt = new Date(Date.now() - 60_000).toISOString();
	const scene = makeScene(parentPid, startedAt);
	// Newer than the instance: this marker describes the exit we are being asked
	// to repair, and it says the exit was intentional.
	writeFileSync(join(scene.stateDir, "clean-exit.json"), `${JSON.stringify({ at: new Date().toISOString() })}\n`, "utf8");

	const { child, exited } = runWatchdog(scene, parentPid);
	const outcome = await Promise.race([exited, new Promise((resolvePromise) => setTimeout(() => resolvePromise(undefined), 20_000))]);
	step(outcome !== undefined, "a watchdog armed after the dsh is gone honours a fresh clean-exit marker", JSON.stringify(outcome ?? "timeout"));
	step(outcome?.code === 0, "it exits cleanly instead of reporting a crash", String(outcome?.code));
	step(!existsSync(scene.startedFile), "it does not relaunch the dsh the user quit");
	step(/asked to exit/u.test(scene.readLog()), "the log says why it stood down", scene.readLog().trim().split("\n").slice(-1)[0]);
	await dispose(scene, child);
}

// --- case B: a marker from BEFORE this life is stale, and must be ignored ----
// The plugin deletes both markers at mount, so a marker older than the guarded
// instance cannot describe its death. Without this, a dsh that crashed before
// its plugin mounted would inherit the previous quit's marker and never be
// restarted again.
{
	const parentPid = await deadPid();
	const startedAt = new Date().toISOString();
	const scene = makeScene(parentPid, startedAt);
	writeFileSync(
		join(scene.stateDir, "clean-exit.json"),
		`${JSON.stringify({ at: new Date(Date.now() - 3_600_000).toISOString() })}\n`,
		"utf8",
	);

	const { child } = runWatchdog(scene, parentPid);
	const relaunched = await waitFor(() => (existsSync(scene.startedFile) ? true : undefined), 30_000);
	step(relaunched === true, "a stale marker does not stop the restart", relaunched === true ? "" : "the dsh was never relaunched");
	step(/ignoring a stale clean-exit marker/u.test(scene.readLog()), "the log records that it ignored the stale marker");
	await dispose(scene, child);
}

if (failures.length > 0) {
	console.error(`\nwatchdog-standdown: ${String(failures.length)} check(s) failed:`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log("\nwatchdog-standdown: ok");
