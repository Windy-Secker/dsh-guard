#!/usr/bin/env node
/**
 * dsh-guard patch editor — the single implementation of "put dsh-guard into a
 * profile's cordis.patch.yml" and "take it out again".
 *
 * This exists because both PowerShell installers used to carry their own copy of
 * this string surgery, and both copies were wrong in different ways: they left
 * the comment preamble behind, left an `- insert:` parent with no children when
 * they removed a row, and (because consuming the BEGIN marker made a second run
 * blind to the region) could no longer clean up what they had written. Two
 * bug-for-bug copies is the actual root cause here, so there is now exactly one.
 *
 * The block is delimited by explicit BEGIN/END markers. Three things are removed
 * together because they are three shapes of the same block: the marker region,
 * the comment preamble above it, and a mount row that predates the markers (an
 * older installer, or a hand edit).
 *
 * CLI:
 *   node bin/patch-guard.mjs --patch <file> --remove
 *   node bin/patch-guard.mjs --patch <file> --install --snippet <template.yml>
 *
 * @module dsh-guard/bin/patch-guard
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** BEGIN/END markers delimiting the region the installer owns outright. */
export const BEGIN_MARKER = ">>> dsh-guard managed block";
export const END_MARKER = "<<< dsh-guard managed block";

/** Does this line start the comment preamble the installer emits? */
function isPreambleStart(line) {
	return /^\s*#\s*dsh-guard/u.test(line);
}

/** Does this line declare the plugin row? */
function isMountRow(line) {
	return /name:\s*'dsh-guard'\s*$/u.test(line);
}

/** Indentation width of one line. */
function indentOf(line) {
	return line.length - line.trimStart().length;
}

/**
 * Remove every shape of a previous dsh-guard block.
 *
 * Removal is a small state machine over three states, because the shapes nest and
 * overlap: the preamble is a comment run, the marker block is a delimited region,
 * and the legacy row is a YAML mapping whose children are more-indented
 * continuation lines (its `- id: guard` sibling line goes with it).
 *
 * Comments are skipped while hunting for the BEGIN marker, because the marker
 * line is itself a comment — the first version looked for BEGIN inside the
 * preamble state and therefore never matched it, which is what made a re-install
 * duplicate the preamble forever.
 *
 * @param text - the patch file body.
 * @returns the body with all dsh-guard content removed.
 */
export function removeGuardBlock(text) {
	const lines = text.split(/\r?\n/u);
	const kept = [];
	let state = "none";

	for (const line of lines) {
		const blank = line.trim() === "";
		const comment = /^\s*#/u.test(line);
		const hasBegin = line.includes(BEGIN_MARKER);
		const hasEnd = line.includes(END_MARKER);

		// Marker recognition comes FIRST, before any state-specific handling.
		// Both markers are comment lines, so a state that skips comments (the
		// preamble run, and the block body itself) would otherwise swallow the very
		// line that ends or opens a region — which is exactly how a re-install kept
		// duplicating its own preamble.
		if (hasBegin) {
			state = "block";
			continue;
		}
		if (state === "block") {
			if (hasEnd) state = "none";
			continue;
		}
		if (state === "preamble") {
			if (comment) continue;
			// The preamble may be followed by a blank separator line before the entry
			// it documents; consume that too, then fall through to handle this line.
			state = "none";
			if (blank) continue;
		} else if (state === "row") {
			if (!blank && indentOf(line) < 4) state = "none";
			else continue;
		}

		if (comment) {
			// A dsh-guard comment opens the preamble; anything else is somebody
			// else's comment and is preserved.
			if (/^\s*#\s*dsh-guard/u.test(line)) state = "preamble";
			else kept.push(line);
			continue;
		}
		if (isMountRow(line)) {
			state = "row";
			const last = kept.length - 1;
			// The row's own `- id: guard` sibling line goes with it.
			if (last >= 0 && /^\s*-\s*id:\s*guard\s*$/u.test(kept[last])) kept.pop();
			continue;
		}
		kept.push(line);
	}

	return dropEmptyInserts(kept);
}

/**
 * Drop `- insert:` entries that have no children.
 *
 * Removing a row leaves its parent behind, and an empty insert is not a valid
 * patch entry — this is how a profile ended up with two bare `- insert:` lines.
 * @param lines - the kept lines.
 * @returns the joined body.
 */
export function dropEmptyInserts(lines) {
	const out = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (/^\s*-\s*insert:\s*$/u.test(line)) {
			let next;
			for (let probe = index + 1; probe < lines.length; probe += 1) {
				if (lines[probe].trim() !== "") {
					next = lines[probe];
					break;
				}
			}
			const needsChild = next !== undefined && indentOf(next) > indentOf(line);
			if (!needsChild) continue;
		}
		out.push(line);
	}
	return `${out.join("\n").trimEnd()}\n`;
}

/**
 * Is the managed block already present?
 * @param text - the patch file body.
 * @returns whether the BEGIN marker appears.
 */
export function hasManagedBlock(text) {
	return text.includes(BEGIN_MARKER);
}

/**
 * Is dsh-guard mounted at all, in any shape?
 * @param text - the patch file body.
 * @returns whether a mount row (managed or legacy) appears.
 */
export function hasGuardRow(text) {
	return text.split(/\r?\n/u).some((line) => isMountRow(line));
}

/**
 * Produce the patched body with the managed block appended exactly once.
 * @param text - the current patch file body.
 * @param snippet - the managed block template (markers included).
 * @returns the new body.
 */
export function installGuardBlock(text, snippet) {
	const body = removeGuardBlock(text);
	const trimmed = body.trim() === "[]" ? "" : body.trimEnd();
	return `${trimmed === "" ? "" : `${trimmed}\n\n`}${snippet.trimEnd()}\n`.trimStart();
}

/**
 * Read a file, or return undefined when it does not exist.
 * @param path - the file path.
 * @returns the file body.
 */
function readIfPresent(path) {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Write a file atomically enough for a config file: temp, then rename. */
function writeFile(path, text) {
	const temp = join(dirname(path), `.${String(process.pid)}.patch-guard.tmp`);
	writeFileSync(temp, text, "utf8");
	renameSync(temp, path);
}

/** Parse `--flag value` pairs. */
function parseArgs(argv) {
	const options = { patch: undefined, snippet: undefined, mode: undefined, dryRun: false };
	for (let index = 0; index < argv.length; index += 1) {
		switch (argv[index]) {
			case "--patch":
				options.patch = argv[(index += 1)];
				break;
			case "--snippet":
				options.snippet = argv[(index += 1)];
				break;
			case "--remove":
				options.mode = "remove";
				break;
			case "--install":
				options.mode = "install";
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			default:
				break;
		}
	}
	return options;
}

const isMain = process.argv[1]?.endsWith("patch-guard.mjs") === true;
if (isMain) {
	const options = parseArgs(process.argv.slice(2));
	if (options.patch === undefined || options.mode === undefined) {
		console.error("usage: node bin/patch-guard.mjs --patch <file> (--remove | --install --snippet <file>) [--dry-run]");
		process.exit(2);
	}
	const before = readIfPresent(options.patch);
	if (before === undefined) {
		console.error(`patch-guard: no such file: ${options.patch}`);
		process.exit(2);
	}

	let after;
	if (options.mode === "remove") {
		after = removeGuardBlock(before);
	} else {
		const snippet = readIfPresent(options.snippet);
		if (snippet === undefined) {
			console.error(`patch-guard: no such snippet: ${String(options.snippet)}`);
			process.exit(2);
		}
		after = installGuardBlock(before, snippet);
	}

	if (after === before) {
		console.log("patch-guard: no change");
		process.exit(0);
	}
	if (options.dryRun) {
		process.stdout.write(after);
		process.exit(0);
	}
	writeFile(options.patch, after);
	console.log(options.mode === "remove" ? "patch-guard: removed" : "patch-guard: installed");
}
