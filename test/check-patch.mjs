#!/usr/bin/env node
/**
 * Static check of a profile's cordis.patch.yml: the dsh-guard row must appear at
 * most once, must carry the plugin name the loader resolves, and must survive a
 * YAML round trip. Mirrors dsh-memory's check-patch so the installers behave the
 * same way. Usage: `node test/check-patch.mjs <path-to-cordis.patch.yml>`.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const path = process.argv[2];
if (path === undefined) {
	console.error("usage: node test/check-patch.mjs <cordis.patch.yml>");
	process.exit(2);
}

let text;
try {
	text = readFileSync(path, "utf8");
} catch (error) {
	if (error.code === "ENOENT") {
		console.log(`check-patch.mjs: ${path} does not exist yet; nothing to check`);
		process.exit(0);
	}
	throw error;
}

// Count the YAML declaration, not the word. The managed block's own BEGIN/END
// marker comments mention dsh-guard as well, so a substring count reports a
// duplicate mount that is not there; comparing the trimmed line is exact.
const rows = text
	.split(/\r?\n/u)
	.filter((line) => {
		const trimmed = line.trim().replace(/^-[ \t]*/u, "");
		return trimmed === "name: 'dsh-guard'" || trimmed === 'name: "dsh-guard"' || trimmed === "name: dsh-guard";
	});
assert.ok(rows.length <= 1, `the dsh-guard row appears ${String(rows.length)} times; it must appear at most once`);

if (rows.length === 0) {
	console.log("check-patch.mjs: dsh-guard is not mounted in this patch");
	process.exit(0);
}

const parsed = parse(text);
assert.ok(Array.isArray(parsed), "a cordis patch must parse as a top-level YAML array");
const entries = parsed.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []));
const guard = entries.find((entry) => entry?.name === "dsh-guard");
assert.ok(guard !== undefined, "the dsh-guard insert row must be present");
assert.equal(guard.id, "guard", "the row id must match what the installer replaces");
if (guard.config !== undefined) {
	assert.equal(typeof guard.config, "object", "the guard config must be a mapping");
	const { stateDir, watchdog, autoResume } = guard.config;
	if (stateDir !== undefined) assert.equal(typeof stateDir, "string", "stateDir must be a string (empty means $DSH_HOME/guard)");
	if (watchdog !== undefined) assert.equal(typeof watchdog, "boolean", "watchdog must be a boolean");
	if (autoResume !== undefined) assert.equal(typeof autoResume, "boolean", "autoResume must be a boolean");
}

console.log(`check-patch.mjs: ok (dsh-guard mounted once in ${path})`);
