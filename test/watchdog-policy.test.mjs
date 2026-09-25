#!/usr/bin/env node
/**
 * Offline check of the watchdog's restart policy and its relaunch recipe. The
 * policy is the difference between "recovers from a crash" and "burns the
 * account in a boot loop", so it is tested without starting any process.
 * Runs with `node test/watchdog-policy.test.mjs`.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlive, parseArgs, portBindable, readGuardStatus, readInvocation, verdictFor } from "../bin/watchdog.mjs";

// --- the verdict: every unintended death is restarted ------------------------
// An explicit stop always wins.
assert.equal(verdictFor({ stopRequested: { at: "x" }, cleanExit: undefined, exitCode: 1, supervising: true }).restart, false);
assert.equal(verdictFor({ stopRequested: { at: "x" }, cleanExit: { at: "x" }, exitCode: 1, supervising: true }).restart, false);

// The Quit button's marker means "do not restart".
const clean = verdictFor({ stopRequested: undefined, cleanExit: { at: "x" }, exitCode: 0, supervising: true });
assert.equal(clean.restart, false);
assert.match(clean.reason, /正常退出/u);

// The guarded dsh's own death IS a crash to repair. Regression: a version
// consulted the previous iteration's flag here and reported the first crash as
// "orphaned watchdog", burning the single restart a boot crash needs.
const firstDeath = verdictFor({ cleanExit: undefined, stopRequested: undefined, exitCode: 1, signal: null, supervising: true });
assert.equal(firstDeath.restart, true, "the first crash must be restarted");

// A silent death restarts, whatever the exit code claims.
assert.equal(verdictFor({ exitCode: 0, supervising: true }).restart, true, "exit code 0 without the marker is still an interruption");
assert.equal(verdictFor({ exitCode: 1, signal: "SIGTERM", supervising: true }).restart, true);
assert.match(verdictFor({ exitCode: 1, signal: "SIGTERM", supervising: true }).reason, /SIGTERM/u);

// A process-level death (Windows access violation) restarts.
assert.equal(verdictFor({ exitCode: 3221225477, supervising: true }).restart, true);

// No information at all is not a restart.
assert.equal(verdictFor({ exitCode: null, signal: null, supervising: true }).restart, false);

// Nothing has been spawned yet, so there is nothing to guard.
assert.equal(verdictFor({ exitCode: 1, supervising: false }).restart, false);

// --- liveness is honest about nonsense pids ---------------------------------
assert.equal(isAlive(process.pid), true);
assert.equal(isAlive(0), false);
assert.equal(isAlive(-1), false);
assert.equal(isAlive(undefined), false);
assert.equal(isAlive(999999999), false);

// --- argument parsing -------------------------------------------------------
const parsed = parseArgs([
	"--state-dir",
	"C:/tmp/guard",
	"--parent-pid",
	"4321",
	"--delay-ms",
	"250",
	"--max-restarts",
	"2",
	"--window-ms",
	"1000",
	"--foreground",
]);
assert.equal(parsed.parentPid, 4321);
assert.equal(parsed.delayMs, 250);
assert.equal(parsed.maxRestarts, 2);
assert.equal(parsed.windowMs, 1000);
assert.equal(parsed.foreground, true);
assert.ok(parsed.stateDir.includes("guard"));

// --- port preflight: the fix for the EADDRINUSE spawn loop ------------------
// Regression: the watchdog used to relaunch dsh unconditionally. When the plugin
// mounted into an already-running dsh, the replacement died at boot with
// EADDRINUSE and the watchdog spawned another doomed process every few seconds.
const holder = createServer();
await new Promise((resolvePromise) => holder.listen(0, "127.0.0.1", resolvePromise));
const takenPort = holder.address().port;

assert.equal(await portBindable(takenPort, 800), false, "a bound port must read as unavailable");
await new Promise((resolvePromise) => holder.close(resolvePromise));
assert.equal(await portBindable(takenPort, 1500), true, "a released port must read as available");
assert.equal(await portBindable(null), true, "an unknown port must not block a restart");
assert.equal(await portBindable(0), true, "port 0 means 'let the OS pick', never a conflict");

// --- --port-conflict parsing ------------------------------------------------
assert.equal(parseArgs(["--port-conflict", "replace"]).portConflict, "replace");
assert.equal(parseArgs(["--port-conflict", "halt"]).portConflict, "halt");
assert.equal(parseArgs(["--port-conflict", "nonsense"]).portConflict, "halt", "an unknown policy falls back to the safe one");
assert.equal(parseArgs([]).portConflict, "halt", "halt is the default policy");

// --- the status probe must be honest about a dead port ----------------------
// No server is listening here, so the probe must resolve undefined rather than
// throwing or inventing a live guard.
assert.equal(await readGuardStatus(1, 400), undefined, "a dead port has no guard status");
assert.equal(await readGuardStatus(null), undefined, "an unknown port has no guard status");

// --- the relaunch recipe is refused rather than guessed ---------------------
const dir = mkdtempSync(join(tmpdir(), "dsh-guard-test-"));
try {
	assert.equal(readInvocation(dir), undefined, "no instance.json means no relaunch");
	writeFileSync(join(dir, "instance.json"), JSON.stringify({ execPath: process.execPath, args: [] }));
	assert.equal(readInvocation(dir), undefined, "no argv means no relaunch");
	writeFileSync(join(dir, "instance.json"), JSON.stringify({ execPath: process.execPath, args: ["C:/definitely/missing.js"] }));
	assert.equal(readInvocation(dir), undefined, "a missing entry script means no relaunch");

	const real = join(dir, "dsh-entry.js");
	writeFileSync(real, "// stand-in for the dsh entry\n");
	mkdirSync(join(dir, "cwd"), { recursive: true });
	writeFileSync(
		join(dir, "instance.json"),
		JSON.stringify({
			execPath: process.execPath,
			args: [real, "--profile", "web"],
			cwd: join(dir, "cwd"),
			options: { autoResume: true },
			port: 3080,
		}),
	);
	const invocation = readInvocation(dir);
	assert.equal(invocation.execPath, process.execPath);
	assert.deepEqual(invocation.args, [real, "--profile", "web"]);
	assert.equal(invocation.autoResume, true);
	assert.equal(invocation.port, 3080);

	writeFileSync(join(dir, "instance.json"), JSON.stringify({ execPath: process.execPath, args: [real], cwd: "C:/nope" }));
	assert.equal(readInvocation(dir).cwd, process.cwd(), "a missing cwd falls back instead of failing");
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log("watchdog-policy.test.mjs: ok");
