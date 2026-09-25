#!/usr/bin/env node
/**
 * Contract test for the browser half (`lib/client.js`).
 *
 * This exists because of a real page-breaking defect: a package declaring
 * `dsh.client` has its `exports["./client"]` served verbatim as a browser bundle,
 * and the client kernel requires that bundle to register a factory on
 * `window.__ModuleLoader__`. The first version of this file exported a Cordis
 * plugin directly (the shape `tool-cordis` dynamic packages use), so the boot
 * combo script registered nothing and every page load died with:
 *
 *   bundle /plugins/??... loaded without registering "..." via __ModuleLoader__.load
 *
 * A unit test cannot see a browser, but it can reproduce exactly the two checks
 * the kernel performs — "did you register?" and "does the factory return a
 * mountable plugin?" — and it can enforce the extra constraint that the factory
 * only requires platform seed modules, because the kernel's `require` throws for
 * anything else at materialization time.
 *
 * Usage: `node test/client-bundle.test.mjs`
 * @module dsh-guard/test/client-bundle
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, "..", "lib", "client.js");
const source = readFileSync(bundlePath, "utf8");

// ---------------------------------------------------------------------------
// A stub of the kernel's registration facade. `load` is the only entry point a
// bundle is allowed to use; it must be present before the bundle executes.
// ---------------------------------------------------------------------------
const registrations = [];
globalThis.window = {
	__ModuleLoader__: {
		load(registration) {
			registrations.push(registration);
		},
	},
};

// ---------------------------------------------------------------------------
// The kernel's seed table for this composition. A factory may require these and
// nothing else; `require` mirrors the kernel's resolution order minus modules
// other plugins would have registered (this package requires none).
// ---------------------------------------------------------------------------
const SEED = new Set([
	"react",
	"react/jsx-runtime",
	"react-dom",
	"react-dom/client",
	"@deepseek-ai/dsh-client-ui-slots",
	"@deepseek-ai/dsh-client-store",
	"@deepseek-ai/dsh-api-remotes",
]);

const required = [];
function kernelRequire(specifier) {
	required.push(specifier);
	if (!SEED.has(specifier)) {
		throw new Error(
			`client-modules: require("${specifier}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory`,
		);
	}
	if (specifier === "react") return REACT;
	if (specifier === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null };
	return {};
}

// ---------------------------------------------------------------------------
// A minimal React stub: enough for `React.createElement`, `useState`, `useRef`,
// and `useEffect` to be exercised without a DOM or a reconciler.
// ---------------------------------------------------------------------------
const REACT = {
	createElement(type, props, ...children) {
		return { type, props: props ?? {}, children: children.flat() };
	},
	useState(initial) {
		return [typeof initial === "function" ? initial() : initial, () => {}];
	},
	useRef(initial) {
		return { current: initial };
	},
	useEffect() {},
};

// ---------------------------------------------------------------------------
// 1. Executing the bundle must REGISTER, not export.
// ---------------------------------------------------------------------------
let threw;
try {
	// eslint-disable-next-line no-new-func -- evaluating the served bundle is the point
	new Function("window", "fetch", source)(globalThis.window, () => Promise.reject(new Error("no network in this test")));
} catch (error) {
	threw = error;
}
assert.equal(threw, undefined, `the bundle must execute without throwing: ${threw?.message ?? ""}`);
assert.equal(registrations.length, 1, `the bundle must register exactly one factory, got ${String(registrations.length)}`);

const registration = registrations[0];
assert.equal(typeof registration.load !== "function", true, "a registration is a plain data object");
assert.equal(registration.id, "dsh-guard", "the registration id must match the package name the host advertises");
assert.equal(typeof registration.factory, "function", "the registration must carry a factory function");

// ---------------------------------------------------------------------------
// 2. Materializing the factory must produce a mountable Cordis plugin.
// ---------------------------------------------------------------------------
const exported = registration.factory(kernelRequire);
assert.equal(typeof exported, "object", "the factory must return an exports object");
assert.equal(typeof exported.apply, "function", "the exports must expose apply()");
assert.equal(exported.name, "guard-client", "the plugin must carry its stable name");
assert.deepEqual(exported.inject, ["slots"], "the plugin must declare the slots service it uses");

// ---------------------------------------------------------------------------
// 3. The factory may only require platform seed modules. This is the check that
//    would have caught a bundle that looks fine locally but throws in the browser
//    ("missed the module table") the moment it materializes.
// ---------------------------------------------------------------------------
assert.ok(required.length > 0, "the factory is expected to require react");
for (const specifier of required) {
	assert.ok(SEED.has(specifier), `the factory requires "${specifier}", which is not a platform seed module`);
}
assert.deepEqual([...new Set(required)], ["react"], `expected exactly one required module, got ${JSON.stringify(required)}`);

// ---------------------------------------------------------------------------
// 4. Applying the plugin must register into the seat beside Settings, and the
//    component it registers must be renderable without a live host.
// ---------------------------------------------------------------------------
const slotRegistrations = [];
const injectedSlots = [];
const ctx = {
	slots: {
		inject(name, factory) {
			injectedSlots.push(name);
			return factory();
		},
		register(options, component) {
			slotRegistrations.push({ options, component });
			return () => {};
		},
	},
};
exported.apply(ctx);

assert.deepEqual(injectedSlots, ["sidebar.footer.action"], "the plugin must inject the footer action seat");
assert.equal(slotRegistrations.length, 1, "the plugin must register exactly one slot entry");
assert.equal(slotRegistrations[0].options.name, "sidebar.footer.action");
assert.equal(slotRegistrations[0].options.id, "guard-quit");
assert.equal(typeof slotRegistrations[0].component, "function", "the slot entry must be a component");

// Rendering it must not throw, and the button must be real: this catches a
// component that assumes host data which only arrives later.
/**
 * Collect the text of every element in a stubbed element tree.
 * @param node - a stubbed React element.
 * @returns every string leaf, in order.
 */
function textOf(node) {
	if (node === null || node === undefined) return [];
	if (typeof node === "string" || typeof node === "number") return [String(node)];
	if (Array.isArray(node)) return node.flatMap(textOf);
	const children = node.children ?? [];
	return children.flatMap(textOf);
}

const element = slotRegistrations[0].component({ wide: true });
assert.equal(element.type, "button", "the entry must render a button");
assert.equal(element.props.type, "button");
assert.equal(typeof element.props.onClick, "function", "the button must be clickable");
assert.equal(element.props["data-dsh-guard"], "idle", "an unarmed, non-quitting button is idle");
// The tooltip is built from status that has not arrived yet on first render, so
// it must still say something honest about the button rather than being empty.
assert.match(String(element.props.title), /dsh-guard|退出 dsh/u, "the tooltip must describe the button even before status loads");
assert.ok(textOf(element).includes("退出"), `the wide layout must label the button, got ${JSON.stringify(textOf(element))}`);

// The collapsed rail renders the glyph only, and must still be a labelled button.
const rail = slotRegistrations[0].component({ wide: false });
assert.equal(rail.type, "button");
assert.match(String(rail.props["aria-label"]), /退出 dsh/u, "the rail button needs an accessible name");

console.log("client-bundle.test.mjs: ok");
