#!/usr/bin/env node
/**
 * Console host for a dsh restarted by the watchdog.
 *
 * WHY THIS EXISTS: the watchdog itself runs detached and console-less. A console
 * program started from a console-less parent gets a BRAND NEW console window for
 * itself — and dsh spawns one such child per background job, so every job popped
 * a black window. Giving dsh a console fixes it: children inherit that console
 * instead of allocating their own.
 *
 * This process is started inside a real console (the watchdog asks PowerShell to
 * create one, hidden or visible), then:
 *   - runs dsh as its child, so dsh inherits that console;
 *   - tees dsh's stdout/stderr to the console window AND to `dsh.log`, so the
 *     forensics log survives even though the output is now visible;
 *   - exits with dsh's exit code, and writes that code to `<log>.exit.json`,
 *     because a 32-bit crash code can be clamped by the wrapper on its way out.
 *
 * Usage: node console-host.mjs --log <dsh.log> -- <dsh entry> [args...]
 * @module dsh-guard/console-host
 */

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync, writeFileSync, writeSync } from "node:fs";

const argv = process.argv.slice(2);
const logIndex = argv.indexOf("--log");
const logPath = logIndex === -1 ? undefined : argv[logIndex + 1];
const separator = argv.indexOf("--");
const execPath = separator === -1 ? undefined : argv[separator + 1];
const args = separator === -1 ? [] : argv.slice(separator + 2);

if (execPath === undefined || logPath === undefined) {
	process.stderr.write("console-host: usage: node console-host.mjs --log <file> -- <command> [args...]\n");
	process.exit(2);
}

/**
 * The console's own output buffer. Even when this process was given NUL for
 * stdout (the watchdog spawns it with stdio ignored), a process that has a
 * console can still write to the console device — that is how text reaches
 * the window.
 *
 * The path must be the device form `\\.\CONOUT$`. The bare name `CONOUT$` is
 * not treated as a device by CreateFile here: with no console attached it
 * silently *creates a file called "CONOUT$"* in the working directory, which
 * is how a stray `CONOUT$` once landed in the repo. The device form fails
 * cleanly instead, and with the `$`-suffix escaped it is unambiguous.
 */
const CONSOLE_DEVICE = "\\\\.\\CONOUT$";
let conout;
try {
	conout = openSync(CONSOLE_DEVICE, "w");
} catch {
	conout = undefined;
}

/** Write one chunk to the log file and, when there is a console, to the window. */
function tee(chunk) {
	try {
		appendFileSync(logPath, chunk);
	} catch {
		/* the log is best-effort; the window still shows it */
	}
	if (conout !== undefined) {
		try {
			writeSync(conout, typeof chunk === "string" ? chunk : Buffer.from(chunk));
		} catch {
			/* the console can disappear under us */
		}
	}
}

tee(`\n===== dsh-guard: console host ${new Date().toISOString()} =====\n`);
tee(`[dsh-guard] dsh was restarted by the watchdog; its output is shown here and logged to ${logPath}\n`);

const child = spawn(execPath, args, {
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: false,
	detached: false,
});
child.stdout.on("data", tee);
child.stderr.on("data", tee);

child.once("error", (error) => {
	tee(`\n[dsh-guard] could not start dsh: ${String(error?.message ?? error)}\n`);
	process.exit(1);
});

child.once("exit", (code, signal) => {
	tee(`\n[dsh-guard] dsh exited: code=${String(code)} signal=${String(signal)}\n`);
	try {
		writeFileSync(`${logPath}.exit.json`, `${JSON.stringify({ code, signal, at: new Date().toISOString() }, null, 2)}\n`, "utf8");
	} catch {
		/* the watchdog falls back to the wrapper's exit code */
	}
	process.exit(code ?? 1);
});
