#!/usr/bin/env node
/**
 * Offline check of the snapshot fold and the resume brief: the part of dsh-guard
 * whose whole job is to survive a crash, so it must be provably correct without
 * a crash. Runs with `node test/snapshot.test.mjs`.
 */
import { strict as assert } from "node:assert";
import { renderResumeBrief, renderResumePrompt, resolveOptions, TaskSnapshot } from "../lib/index.js";

const events = [
	{ type: "turn/start", seq: 4, time: 1000, data: { turn: 1 } },
	{ type: "user/message", seq: 8, time: 1100, data: { content: [{ type: "text", text: "把 A 和 B 都改掉" }] } },
	{ type: "step/start", seq: 9, time: 1200, data: { turn: 1, step: 1 } },
	{ type: "assistant/message", seq: 15, time: 1300, data: { message: { content: [{ type: "text", text: "先看代码" }] } } },
	{
		type: "tool/call",
		seq: 16,
		time: 1400,
		data: { turn: 1, step: 1, callId: "call_1", name: "read", arguments: '{"file_path":"a.ts"}' },
	},
	{
		type: "tool/result",
		seq: 17,
		time: 1450,
		data: { turn: 1, step: 1, message: { source: { kind: "tool", callId: "call_1" }, content: [{ type: "text", text: "…" }] } },
	},
	{
		type: "todo/write",
		seq: 22,
		time: 1500,
		data: {
			todos: [
				{ content: "改 A", status: "completed" },
				{ content: "改 B", status: "in_progress" },
				{ content: "跑测试", status: "pending" },
			],
		},
	},
	{
		type: "tool/call",
		seq: 30,
		time: 1600,
		data: { turn: 1, step: 2, callId: "call_2", name: "pwsh", arguments: '{"command":"pnpm test"}' },
	},
];

const snapshot = new TaskSnapshot("session-test", "E:\\work");
for (const event of events) snapshot.apply(event);
snapshot.trim(40);

// --- the todo list is the thing that used to vanish -------------------------
assert.equal(snapshot.todos.length, 3, "todo list must survive the fold");
assert.deepEqual(snapshot.counts(), { pending: 1, inProgress: 1, completed: 1 });
assert.equal(snapshot.phase, "running", "a turn without turn/end is an interrupted task");
assert.equal(snapshot.turn, 1);
// `step` counts steps WITHIN a turn (the loop resets phase.step to 0 at each
// turn boundary), and only step/start moves it — a tool/call carrying a step
// number must not advance the recorded position on its own.
assert.equal(snapshot.step, 1);
assert.equal(snapshot.lastUserMessage, "把 A 和 B 都改掉");
assert.equal(snapshot.lastAssistantText, "先看代码");

// --- only unresolved tool calls are reported as in flight -------------------
assert.equal(snapshot.openToolCalls.length, 1, "the resolved read call must be dropped");
assert.equal(snapshot.openToolCalls[0].name, "pwsh");
assert.equal(snapshot.toolCallCount, 2);

// --- a completed turn is not "interrupted" ---------------------------------
const done = new TaskSnapshot("session-2", "E:\\work");
done.apply({ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } });
done.apply({ type: "todo/write", seq: 2, time: 2, data: { todos: [{ content: "唯一任务", status: "pending" }] } });
done.apply({ type: "turn/end", seq: 3, time: 3, data: { turn: 1 } });
assert.equal(done.phase, "idle");
assert.equal(done.toJSON().interrupted, false);
assert.equal(done.todos.length, 1, "a turn/end must not erase the recorded list");

// --- the tail is bounded and keeps the newest events ------------------------
const tail = new TaskSnapshot("session-3");
for (let index = 0; index < 100; index += 1) {
	tail.apply({ type: "tool/call", seq: index, time: index, data: { callId: `c${String(index)}`, name: "x", arguments: "{}" } });
	tail.trim(10);
}
assert.equal(tail.tail.length, 10);
assert.equal(tail.tail.at(-1).seq, 99);

// --- the brief mentions the list, the crash reason, and the next action -----
const brief = renderResumeBrief(snapshot.toJSON({ crash: { reason: "uncaughtException", detail: "boom", at: "2026-01-01T00:00:00.000Z" } }));
assert.match(brief, /任务列表（1 完成 \/ 1 进行中 \/ 1 待办）/u);
assert.match(brief, /- \[x\] 改 A/u);
assert.match(brief, /- \[→\] 改 B/u);
assert.match(brief, /- \[ \] 跑测试/u);
assert.match(brief, /uncaughtException/u);
assert.match(brief, /继续方式/u);

// --- the autoResume prompt carries the list, not a pointer ------------------
const prompt = renderResumePrompt("继续：\n{{snapshot}}", snapshot.toJSON(), { reason: "异常终止（退出码 1）", snapshotPath: "X:/snapshot.json" });
assert.match(prompt, /继续：/u);
assert.match(prompt, /- \[→\] 改 B/u);
assert.match(prompt, /exit|退出码 1/u);
assert.match(prompt, /X:\/snapshot\.json/u);
assert.ok(!prompt.includes("{{snapshot}}"), "the placeholder must be replaced");

// --- option resolution: empty stateDir means the default, not "" ------------
const options = resolveOptions({ stateDir: "", autoResume: true, maxRestarts: 3 });
assert.ok(options.stateDir.endsWith("guard"), `expected the default guard dir, got ${options.stateDir}`);
assert.equal(options.autoResume, true);
assert.equal(options.maxRestarts, 3);
assert.equal(options.watchdog, true, "the watchdog is on by default");
assert.equal(resolveOptions({ watchdog: false }).watchdog, false);
assert.equal(resolveOptions({ autoResume: false }).autoResume, false, "autoResume is off by default");

console.log("snapshot.test.mjs: ok");
