#!/usr/bin/env node
/**
 * Tests for the profile-patch editor (`bin/patch-guard.mjs`).
 *
 * This is the one piece of string surgery both installers depend on, and it has
 * already been wrong twice: the first version left the comment preamble behind
 * (so a profile accumulated identical blocks on every install), and the second
 * left an `- insert:` parent with no children when it removed a row. Both are
 * asserted against here, together with the property that made them invisible —
 * running the operation twice must equal running it once.
 *
 * Usage: `node test/patch-guard.test.mjs`
 * @module dsh-guard/test/patch-guard
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installGuardBlock, removeGuardBlock } from "../bin/patch-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const snippet = readFileSync(join(here, "..", "cordis.patch.snippet.yml"), "utf8");

/** A patch body holding two unrelated plugins, as a real profile would. */
const BASE = [
	"# Your patch layer for this dsh profile.",
	"",
	"# balance badge",
	"- insert:",
	"    - id: balance-badge",
	"      name: 'dsh-balance-badge'",
	"      config:",
	"        warnBelow: 8",
	"",
	"# memory",
	"- insert:",
	"    - id: memory",
	"      name: 'dsh-memory'",
	"      config:",
	"        storeDir: 'E:/dsh/memory'",
	"",
].join("\n");

const countOf = (text, pattern) => (text.match(pattern) ?? []).length;

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------
const once = installGuardBlock(BASE, snippet);
assert.equal(countOf(once, new RegExp(">>> dsh-guard managed block", "gu")), 1, "exactly one BEGIN marker");
assert.equal(countOf(once, new RegExp("<<< dsh-guard managed block", "gu")), 1, "exactly one END marker");
assert.equal(countOf(once, /^\s*-\s*id:\s*guard\s*$/gmu), 1, "exactly one guard row");
assert.equal(countOf(once, /dsh-balance-badge/u), 1, "the balance-badge row survives");
assert.equal(countOf(once, /dsh-memory/u), 1, "the memory row survives");
assert.equal(countOf(once, /^\s*-\s*insert:\s*$/gmu), 3, "three insert entries: two plugins plus the guard");

// Installing again must change nothing. This is the property the duplicate-block
// defect violated: the preamble was appended a second time.
const twice = installGuardBlock(once, snippet);
assert.equal(twice, once, "installing twice must be identical to installing once");
assert.equal(countOf(twice, new RegExp("# dsh-guard", "gu")), countOf(once, new RegExp("# dsh-guard", "gu")), "no duplicated preamble");

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------
const removed = removeGuardBlock(once);
assert.equal(countOf(removed, /dsh-guard/u), 0, "every mention of dsh-guard is gone, including the comment preamble");
assert.equal(countOf(removed, /^\s*-\s*id:\s*guard\s*$/gmu), 0, "the guard row is gone");
assert.equal(countOf(removed, /dsh-balance-badge/u), 1, "the balance-badge row survives removal");
assert.equal(countOf(removed, /dsh-memory/u), 1, "the memory row survives removal");
// An `- insert:` with no children is not a valid patch entry. Removing a row used
// to leave its parent behind.
assert.equal(countOf(removed, /^\s*-\s*insert:\s*$/gmu), 2, "no orphaned insert parent is left behind");

// Removing again must change nothing.
assert.equal(removeGuardBlock(removed), removed, "removing twice must be identical to removing once");

// Round trip: install after remove reproduces the same single block.
assert.equal(installGuardBlock(removed, snippet), once, "install(remove(x)) equals the first install");

// ---------------------------------------------------------------------------
// Legacy shapes: a row without markers, and orphaned parents from the wreckage
// of an earlier uninstall. Both appear in real profiles this tool has repaired.
// ---------------------------------------------------------------------------
const legacy = [
	"# memory",
	"- insert:",
	"    - id: memory",
	"      name: 'dsh-memory'",
	"      config:",
	"        storeDir: 'E:/x'",
	"",
	"# dsh-guard: hand-written by an older installer",
	"# more comment lines",
	"- insert:",
	"    - id: guard",
	"      name: 'dsh-guard'",
	"      config:",
	"        watchdog: true",
	"",
	"- insert:",
	"- insert:",
	"",
].join("\n");

const repaired = removeGuardBlock(legacy);
assert.equal(countOf(repaired, /dsh-guard/u), 0, "a legacy row and its comment preamble are removed");
assert.equal(countOf(repaired, /dsh-memory/u), 1, "an unrelated plugin is untouched");
assert.equal(countOf(repaired, /^\s*-\s*insert:\s*$/gmu), 1, "the two orphaned insert parents are dropped");
assert.equal(countOf(repaired, /^\s*-\s*id:\s*memory\s*$/gmu), 1, "the memory row's own parent is kept");

// ---------------------------------------------------------------------------
// A profile that never had the plugin is returned unchanged, and an empty patch
// sentinel is preserved so the loader keeps reading it as a list.
// ---------------------------------------------------------------------------
assert.equal(removeGuardBlock(BASE), BASE, "a patch without dsh-guard is returned unchanged");
assert.equal(removeGuardBlock("[]\n").trim(), "[]", "the empty-array sentinel survives");
assert.equal(countOf(installGuardBlock("[]\n", snippet), /^\s*-\s*insert:\s*$/gmu), 1, "installing into an empty patch yields one entry");

// Windows line endings must not defeat the matcher.
const crlf = `${BASE.replace(/\n/gu, "\r\n")}${"- insert:\r\n    - id: guard\r\n      name: 'dsh-guard'\r\n\r\n"}`;
const crlfRemoved = removeGuardBlock(crlf);
assert.equal(countOf(crlfRemoved, /dsh-guard/u), 0, "a CRLF patch is cleaned too");

console.log("patch-guard.test.mjs: ok");
