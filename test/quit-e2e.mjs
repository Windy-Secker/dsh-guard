#!/usr/bin/env node
/**
 * End-to-end verification of the dsh-guard Quit path, run against a throwaway dsh
 * instance so the operator's own dsh and its running tasks are untouched.
 *
 * What it proves:
 *   1. the plugin mounts, serves /dsh-guard/status, and spawns a watchdog;
 *   2. POST /dsh-guard/quit is accepted and writes the clean-exit marker;
 *   3. the process then leaves on its own with code 0 (a graceful Cordis dispose,
 *      not a kill);
 *   4. the watchdog sees the marker and stands down instead of restarting dsh.
 *
 * The throwaway profile is built from scratch under the OS temp dir: its own
 * DSH_HOME, its own port, its own state directory, and a junction (or copy) of
 * this package into that profile's node_modules. Nothing outside the temp tree is
 * read or written, so a checkout can run this without touching a real install.
 *
 * Usage: node test/quit-e2e.mjs [--dsh <path to bin.js>] [--keep]
 * Exits non-zero when any check fails.
 *
 * @module dsh-guard/test/quit-e2e
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
const dshIndex = argv.indexOf("--dsh");
const DSH_ENTRY =
	dshIndex === -1
		? join(process.env.APPDATA ?? "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
		: argv[dshIndex + 1];
const keep = argv.includes("--keep");

if (!existsSync(DSH_ENTRY)) {
	console.error(`dsh entry not found at ${DSH_ENTRY}; pass --dsh <path to lib/bin.js>`);
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

/** One GET/POST with a hard timeout; never throws for an HTTP status. */
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

/** Poll until `check()` returns something truthy, or give up. */
async function waitFor(check, timeoutMs, intervalMs = 400) {
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

const home = join(tmpdir(), `dsh-guard-quit-${String(process.pid)}`);
const profileDir = join(home, "profiles", "web");
const stateDir = join(home, "guard");
const logPath = join(home, "dsh-output.log");
const failures = [];
const step = (ok, label, detail = "") => {
	if (!ok) failures.push(label);
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`);
};

let dsh = null;

try {
	mkdirSync(join(profileDir, "node_modules"), { recursive: true });

	// The profile: the shipped web bundle plus one guard row pointing at this
	// test's state directory.
	writeFileSync(
		join(profileDir, "package.json"),
		`${JSON.stringify(
			{
				name: "dsh-profile-web",
				private: true,
				dsh: {
					profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], patchReload: "live" },
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	writeFileSync(join(profileDir, "cordis.yml"), "[]\n", "utf8");
	writeFileSync(
		join(profileDir, "cordis.patch.yml"),
		[
			"# quit-e2e profile: the guard with a throwaway state directory.",
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

	// Make the package resolvable from that profile without touching a real
	// install. A junction keeps it live for local iteration; a copy is the
	// fallback when link creation is not permitted.
	const linked = join(profileDir, "node_modules", "dsh-guard");
	let linkedHow = "junction";
	try {
		symlinkSync(packageRoot, linked, "junction");
	} catch {
		linkedHow = "copy";
		cpSync(packageRoot, linked, {
			recursive: true,
			filter: (source) => !source.includes(`${join(packageRoot, ".git")}`),
		});
	}

	const port = await freePort();
	let out = "ignore";
	try {
		mkdirSync(home, { recursive: true });
		out = openSync(logPath, "a");
	} catch {
		out = "ignore";
	}
	const readOutput = () => {
		try {
			return readFileSync(logPath, "utf8");
		} catch {
			return "";
		}
	};

	console.log(`profile: ${profileDir} (guard ${linkedHow})`);
	console.log(`state:   ${stateDir}`);
	console.log(`port:    ${String(port)}`);

	dsh = spawn(process.execPath, [DSH_ENTRY, "web", "--port", String(port), "--no-open"], {
		cwd: packageRoot,
		env: { ...process.env, DSH_HOME: home },
		// File-backed output, never pipes: a confined sandbox refuses the named
		// pipes Node uses for piped stdio (`spawn EPERM`), and a log file is more
		// useful for diagnosis anyway.
		stdio: ["ignore", out, out],
	});
	if (out !== "ignore") {
		try {
			closeSync(out);
		} catch {
			/* the child owns the descriptor now */
		}
	}
	const exited = new Promise((resolvePromise) => dsh.once("exit", (code, signal) => resolvePromise({ code, signal })));

	const status = await waitFor(async () => {
		const result = await call(`http://127.0.0.1:${String(port)}/dsh-guard/status`);
		return result.status === 200 ? result.body : undefined;
	}, 120_000, 700);

	step(status !== undefined, "plugin mounted and /dsh-guard/status answers");
	if (status === undefined) {
		console.error(`--- throwaway dsh output (tail) ---\n${readOutput().slice(-3000)}`);
		throw new Error("the throwaway dsh never served the guard status route");
	}
	step(status.port === port, "status reports the bound port", String(status.port));
	step(status.watchdog?.status === "running", "watchdog spawned", JSON.stringify(status.watchdog));
	const watchdogPid = typeof status.watchdog?.pid === "number" ? status.watchdog.pid : null;

	// What the host will serve as the client bundle must be a registering bundle.
	//
	// The host serves `exports["./client"]` VERBATIM (client-modules snapshots the
	// file and hands the bytes to the combo route), so the wire content is exactly
	// these file bytes — asserting on the file is asserting on the wire without
	// needing the full browser composition. The bootstrap and combo routes are
	// revision-addressed, so a test cannot guess their URLs, and the shell's index
	// is behind the connection's auth gate in a throwaway instance; this is the
	// deterministic check. `test/client-bundle.test.mjs` covers execution.
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	const clientPath = join(packageRoot, manifest.exports["./client"]);
	step(existsSync(clientPath), "the manifest's client bundle exists", clientPath);
	step(manifest.dsh?.client?.platform === "web", "the package declares dsh.client.platform = web");
	if (existsSync(clientPath)) {
		const clientSource = readFileSync(clientPath, "utf8");
		step(clientSource.includes("__ModuleLoader__.load"), "the served bundle registers a factory (kernel requirement)");
		step(clientSource.includes('id: "dsh-guard"'), "the factory registers under the advertised package id");
	}

	const quit = await call(`http://127.0.0.1:${String(port)}/dsh-guard/quit`, "POST");
	step(quit.status === 200 && quit.body?.quitting === true, "POST /dsh-guard/quit accepted", `HTTP ${String(quit.status)}`);

	const marker = await waitFor(() => (existsSync(join(stateDir, "clean-exit.json")) ? true : undefined), 5000);
	step(marker === true, "clean-exit marker written (the watchdog's stand-down credential)");

	const outcome = await Promise.race([
		exited,
		new Promise((resolvePromise) => setTimeout(() => resolvePromise(undefined), 30_000)),
	]);
	step(outcome !== undefined, "dsh exited on its own after the quit");
	step(outcome?.code === 0, "exit code is 0 (graceful dispose, not a kill)", JSON.stringify(outcome ?? null));

	const watchdogGone = await waitFor(() => {
		if (watchdogPid === null) return true;
		try {
			process.kill(watchdogPid, 0);
			return undefined;
		} catch {
			return true;
		}
	}, 15_000, 500);
	step(watchdogGone === true, "watchdog stood down instead of restarting dsh");

	// A restart would show up as a second supervised start block in the log.
	const restarts = (readOutput().match(/dsh-guard: start/gu) ?? []).length;
	step(restarts <= 1, "no replacement dsh was spawned", `${String(restarts)} start marker(s)`);
} catch (error) {
	failures.push(error.message);
	console.error(`error: ${error.message}`);
} finally {
	if (dsh !== null && dsh.exitCode === null) {
		dsh.kill();
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
	}
	if (keep) {
		console.log(`kept for inspection: ${home}`);
	} else {
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			/* a locked log is not worth failing on */
		}
	}
}

if (failures.length > 0) {
	console.error(`\nquit-e2e: ${String(failures.length)} check(s) failed:`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log("\nquit-e2e: ok");
