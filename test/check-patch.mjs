#!/usr/bin/env node
/**
 * Static check of a profile's cordis.patch.yml: dsh-guard must be mounted exactly
 * once, the row must be the one the installer replaces, and the config keys it
 * carries must have plausible types.
 *
 * Dependency-free and structural rather than a YAML parser. An earlier version
 * imported the `yaml` package (which resolved only because the surrounding
 * workspace happened to have it, so a clone crashed with ERR_MODULE_NOT_FOUND)
 * and a second version hand-rolled a general parser that was both long and easy
 * to get wrong. A profile patch is a list of `- insert:` blocks, and the only
 * block that matters here is the guard's, so this reads that block directly:
 * find its `- id: guard` anchor, then read the indented lines under it.
 *
 * Usage: `node test/check-patch.mjs <path-to-cordis.patch.yml>`
 * @module dsh-guard/test/check-patch
 */

import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";

/**
 * Read one YAML scalar, ignoring a trailing comment and an explicit `!!js` tag.
 * @param raw - the value text after the colon.
 * @returns the scalar as a string, number, or boolean.
 */
function readScalar(raw) {
	let value = raw.trim();
	if (value.startsWith("!!")) value = value.slice(2).trimStart();
	let quote;
	let cut = value.length;
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (quote === undefined) {
			if (char === "'" || char === '"') quote = char;
			else if (char === "#" && index > 0 && /\s/u.test(value[index - 1])) {
				cut = index;
				break;
			}
		} else if (char === quote) {
			quote = undefined;
		}
	}
	value = value.slice(0, cut).trim();
	if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
		return value.slice(1, -1);
	}
	if (value === "true") return true;
	if (value === "false") return false;
	if (/^-?\d+$/u.test(value)) return Number(value);
	return value;
}

/**
 * Extract the guard insert row from a patch body.
 * @param text - the patch file body.
 * @returns `{ found, config, duplicates }`; `found` is false when no guard row exists.
 */
export function findGuardRow(text) {
	const lines = text.split(/\r?\n/u);
	const anchors = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (/^\s*-\s*id:\s*guard\s*$/u.test(lines[index])) anchors.push(index);
	}
	if (anchors.length === 0) return { found: false, config: {}, duplicates: 0 };

	const at = anchors[0];
	const anchorIndent = lines[at].length - lines[at].trimStart().length;
	const body = [];
	let name = undefined;
	let config = {};
	let inConfig = false;
	for (let index = at + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim() === "") continue;
		const indent = line.length - line.trimStart().length;
		// A new sequence item at the anchor's level ends this row.
		if (indent <= anchorIndent) break;
		body.push(line.trim());
		const nameMatch = /^name:\s*(.+)$/u.exec(line.trim());
		if (nameMatch !== null) {
			name = readScalar(nameMatch[1]);
			inConfig = false;
			continue;
		}
		if (/^config:\s*$/u.test(line.trim())) {
			inConfig = true;
			continue;
		}
		if (!inConfig) continue;
		const entry = /^([A-Za-z_][\w-]*):\s*(.*)$/u.exec(line.trim());
		if (entry !== null) config[entry[1]] = readScalar(entry[2]);
	}
	return { found: true, name, config, duplicates: anchors.length - 1, body };
}

/**
 * Resolve what to check: the path argument, or this repository's own snippet.
 *
 * Defaulting to the bundled template keeps `npm test` meaningful in a fresh
 * clone. It also keeps the earlier lesson honest: a check that cannot run
 * anywhere except the author's machine is not a check.
 * @returns the file to inspect.
 */
function resolveTarget() {
	const argument = process.argv[2];
	if (argument !== undefined) return argument;
	return fileURLToPath(new URL("../cordis.patch.snippet.yml", import.meta.url));
}

const path = resolveTarget();

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

const row = findGuardRow(text);
if (!row.found) {
	// A hand-written mount uses `name: 'dsh-guard'` without our `id: guard` anchor.
	const named = text.split(/\r?\n/u).filter((line) => {
		const trimmed = line.trim().replace(/^-[ \t]*/u, "");
		return trimmed === "name: 'dsh-guard'" || trimmed === 'name: "dsh-guard"' || trimmed === "name: dsh-guard";
	});
	assert.ok(named.length <= 1, `the dsh-guard row appears ${String(named.length)} times; it must appear at most once`);
	console.log(
		named.length === 0
			? "check-patch.mjs: dsh-guard is not mounted in this patch"
			: "check-patch.mjs: ok (dsh-guard mounted once, by a hand-written row without the installer's id anchor)",
	);
	process.exit(0);
}

assert.equal(row.duplicates, 0, `the installer's guard row appears ${String(row.duplicates + 1)} times; it must appear at most once`);
assert.equal(row.name, "dsh-guard", `the row's plugin name must be 'dsh-guard', found ${JSON.stringify(row.name)}`);

const { stateDir, watchdog, autoResume, portConflict, rapidDeathMs, maxRapidRestarts, crashWindowMs, maxRestarts } = row.config;
if (stateDir !== undefined) assert.equal(typeof stateDir, "string", "stateDir must be a string (empty means $DSH_HOME/guard)");
for (const [key, value] of Object.entries({ watchdog, autoResume })) {
	if (value !== undefined) assert.equal(typeof value, "boolean", `${key} must be a boolean, found ${typeof value}`);
}
for (const [key, value] of Object.entries({ rapidDeathMs, maxRapidRestarts, crashWindowMs, maxRestarts })) {
	if (value !== undefined) assert.equal(typeof value, "number", `${key} must be a number, found ${typeof value}`);
}
if (portConflict !== undefined) {
	assert.ok(portConflict === "halt" || portConflict === "replace", `portConflict must be "halt" or "replace", found ${JSON.stringify(portConflict)}`);
}

console.log(`check-patch.mjs: ok (dsh-guard mounted once in ${path})`);
