/**
 * dsh-guard — crash guard for the DeepSeek Harness Web GUI (host half).
 *
 * Four jobs, one plugin:
 *
 *   1. A graceful way out. `/dsh-guard/quit` (the sidebar's Quit button calls it)
 *      writes the watchdog's clean-exit marker, disposes the Cordis tree so
 *      session logs drain, and only then ends the process.
 *   2. A reason for every death. `uncaughtException`, `unhandledRejection`, and
 *      `process.on('exit')` are recorded to the state directory before anything
 *      else can swallow them, so a fatal error leaves a file and not silence.
 *   3. A live task snapshot. Session events are folded into `snapshot.json`
 *      (todo list, goal, in-flight tool calls, last human instruction, recent
 *      events) plus a human-readable `resume.md` brief.
 *   4. A watchdog outside dsh. A detached `bin/watchdog.mjs` process is spawned
 *      with the exact command line needed to relaunch this dsh; when dsh dies
 *      without the clean-exit marker, the watchdog restarts it.
 *
 * Cordis plugin contract: named exports `name`, `inject`, `Config`, `apply` —
 * never a default export, which the loader would downgrade to a bare function
 * and strip of its injection metadata.
 * @module dsh-guard
 */

import { spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "guard";
export const inject = ["webServer"];

/** Route paths served by the host half. */
export const STATUS_PATH = "/dsh-guard/status";
export const SNAPSHOT_PATH = "/dsh-guard/snapshot";
export const CRASH_PATH = "/dsh-guard/crash";
export const QUIT_PATH = "/dsh-guard/quit";

/** The prompt the watchdog injects when `autoResume` is on and a task was interrupted. */
export const DEFAULT_RESUME_PROMPT = [
	"【dsh-guard 自动续跑】上一次 dsh 进程在任务执行中被异常终止，看门狗已重启本进程。",
	"下面是崩溃前保存的任务快照，请据此判断进度并在原任务上继续；若已基本完成，只需说明现状并补齐收尾。",
	"",
	"{{snapshot}}",
].join("\n");

/** Fixed file names inside the state directory. */
export const FILES = Object.freeze({
	instance: "instance.json",
	status: "status.json",
	snapshot: "snapshot.json",
	resume: "resume.md",
	refs: "session-refs.json",
	crash: "crash.json",
	crashLog: "crashes.log",
	cleanExit: "clean-exit.json",
	stop: "stop.json",
	watchdogPid: "watchdog.pid",
	watchdogLog: "watchdog.log",
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Resolve the plugin row config into the values the plugin actually works with.
 * Every field is optional; the defaults are the shipped behaviour.
 * @param raw - the row's `config` object (or undefined).
 * @returns a frozen option snapshot.
 */
export function resolveOptions(raw) {
	const config = raw ?? {};
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const configured = typeof config.stateDir === "string" ? config.stateDir.trim() : "";
	return Object.freeze({
		stateDir: resolve(configured === "" ? join(home, "guard") : configured),
		watchdog: config.watchdog !== false,
		restartDelayMs: numberOr(config.restartDelayMs, 1500, 0),
		maxRestarts: numberOr(config.maxRestarts, 10, 0),
		crashWindowMs: numberOr(config.crashWindowMs, 600_000, 0),
		tailEvents: numberOr(config.tailEvents, 40, 0),
		timeoutMs: numberOr(config.timeoutMs, 4000, 250),
		autoResume: config.autoResume === true,
		resumePrompt:
			typeof config.resumePrompt === "string" && config.resumePrompt.trim() !== "" ? config.resumePrompt : DEFAULT_RESUME_PROMPT,
		keepSessions: numberOr(config.keepSessions, 12, 1),
		// What the watchdog does when the recorded port is already held by a
		// process it does not own. "halt" (the default) stops supervision with a
		// diagnostic instead of spawning dsh after dsh that cannot bind.
		portConflict: config.portConflict === "replace" ? "replace" : "halt",
		// Boot-crash brake: a restart that dies within rapidDeathMs counts as an
		// immediate crash, and maxRapidRestarts of them in a row end supervision
		// instead of retrying forever — a restarted dsh that instantly dies again
		// is a broken configuration, not an unlucky crash.
		rapidDeathMs: numberOr(config.rapidDeathMs, 3000, 0),
		maxRapidRestarts: numberOr(config.maxRapidRestarts, 3, 0),
	});
}

/** Coerce to a non-negative finite number, or a fallback. */
function numberOr(value, fallback, min) {
	return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

// ---------------------------------------------------------------------------
// Small file helpers
// ---------------------------------------------------------------------------

/** Durable write: temp file plus rename, tolerant of a missing directory. */
export function writeJson(path, value) {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const temp = `${path}.tmp-${String(process.pid)}`;
		writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		renameSync(temp, path);
		return true;
	} catch {
		return false;
	}
}

/** Append one line, never throwing (crash paths must not crash). */
export function appendLine(path, text) {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${text}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

/** Read and parse a JSON file, returning undefined when absent or torn. */
export function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Read a text file, or undefined when absent. */
export function readTextFile(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Last `limit` lines of a crash log, newest last. */
export function readCrashTail(path, limit) {
	const text = readTextFile(path);
	if (text === undefined) return [];
	return text.split(/\r?\n/u).filter((line) => line !== "").slice(-limit);
}

/** List one directory as `{ name, mtimeMs }`, or an empty list. */
export function listFiles(dir) {
	try {
		return readdirSync(dir).map((entry) => {
			try {
				return { name: entry, mtimeMs: statSync(join(dir, entry)).mtimeMs };
			} catch {
				return { name: entry, mtimeMs: 0 };
			}
		});
	} catch {
		return [];
	}
}

/** Remove a file if it exists, ignoring failures. */
export function remove(path) {
	try {
		rmSync(path, { force: true });
	} catch {
		/* already gone */
	}
}

/** Filesystem-safe rendering of a session id. */
export function safeName(value) {
	return String(value).replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120);
}

/** One-line summary of an unknown thrown value. */
function describeError(error) {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

/** Full stack (or a descriptive fallback) of an unknown thrown value. */
function stackOf(error) {
	if (error instanceof Error && typeof error.stack === "string") return error.stack;
	return String(error);
}

// ---------------------------------------------------------------------------
// Session state → snapshot
// ---------------------------------------------------------------------------

/**
 * The per-session snapshot accumulator. Pure data folding: the plugin can flush
 * at any moment without the fold having to agree with the event stream about
 * ordering, because events only ever arrive in seq order.
 */
export class TaskSnapshot {
	/**
	 * @param sessionId - the session this snapshot belongs to.
	 * @param cwd - the session's working directory, when known.
	 */
	constructor(sessionId, cwd) {
		this.sessionId = sessionId;
		this.cwd = cwd ?? null;
		this.createdAt = new Date().toISOString();
		this.updatedAt = this.createdAt;
		this.turn = null;
		this.step = null;
		this.phase = "idle";
		this.todos = null;
		this.goal = null;
		this.lastUserMessage = null;
		this.lastAssistantText = null;
		this.openToolCalls = [];
		this.toolCallCount = 0;
		this.eventCount = 0;
		this.lastSeq = null;
		this.lastEvent = null;
		this.tail = [];
	}

	/**
	 * Fold one session event in.
	 * @param event - the appended session event (`{ type, seq, time, data }`).
	 */
	apply(event) {
		if (event === null || typeof event !== "object") return;
		this.eventCount += 1;
		const data = event.data ?? {};
		if (typeof event.seq === "number") this.lastSeq = event.seq;
		this.lastEvent = { type: event.type, seq: this.lastSeq, time: event.time ?? null };
		this.updatedAt = new Date().toISOString();
		this.tail.push({
			type: event.type,
			seq: this.lastSeq,
			time: event.time ?? null,
			summary: summarizeEvent(event),
		});

		switch (event.type) {
			case "turn/start":
				this.turn = data.turn ?? this.turn;
				this.phase = "running";
				break;
			case "turn/end":
				this.phase = "idle";
				this.step = null;
				break;
			case "step/start":
				this.turn = data.turn ?? this.turn;
				this.step = data.step ?? this.step;
				this.phase = "running";
				break;
			case "step/end":
				this.phase = "idle";
				break;
			case "todo/write":
				this.todos = Array.isArray(data.todos) ? data.todos.map(normalizeTodo) : null;
				break;
			case "goal/change":
				this.goal = data.goal ?? null;
				break;
			case "tool/call": {
				this.toolCallCount += 1;
				const callId = data.callId ?? null;
				this.openToolCalls = this.openToolCalls.filter((call) => call.callId !== callId);
				this.openToolCalls.push({
					callId,
					name: data.name ?? null,
					turn: data.turn ?? null,
					step: data.step ?? null,
					arguments: clampText(data.arguments, 800),
					at: event.time ?? null,
				});
				if (this.openToolCalls.length > 12) this.openToolCalls = this.openToolCalls.slice(-12);
				break;
			}
			case "tool/result": {
				const callId = data.message?.source?.callId ?? null;
				this.openToolCalls = this.openToolCalls.filter((call) => call.callId !== callId);
				break;
			}
			case "user/message":
				this.lastUserMessage = clampText(blocksToText(data.content), 2000);
				break;
			case "assistant/message":
				this.lastAssistantText = clampText(blocksToText(data.message?.content), 1200);
				break;
			default:
				break;
		}
	}

	/** The todo counts a resume brief wants, or null when no list was written. */
	counts() {
		if (!Array.isArray(this.todos)) return null;
		const count = (status) => this.todos.filter((todo) => todo.status === status).length;
		return { pending: count("pending"), inProgress: count("in_progress"), completed: count("completed") };
	}

	/** Drop the oldest tail entries beyond `limit`. */
	trim(limit) {
		if (this.tail.length > limit) this.tail = this.tail.slice(-limit);
	}

	/**
	 * Serialize for disk.
	 * @param extra - fields the caller adds (crash context, watchdog facts).
	 * @returns a plain JSON-serializable object.
	 */
	toJSON(extra = {}) {
		return {
			schema: "dsh-guard/snapshot@1",
			sessionId: this.sessionId,
			cwd: this.cwd,
			createdAt: this.createdAt,
			updatedAt: this.updatedAt,
			phase: this.phase,
			interrupted: this.phase !== "idle",
			turn: this.turn,
			step: this.step,
			todos: this.todos,
			todoCounts: this.counts(),
			goal: this.goal,
			lastUserMessage: this.lastUserMessage,
			lastAssistantText: this.lastAssistantText,
			openToolCalls: this.openToolCalls,
			toolCallCount: this.toolCallCount,
			eventCount: this.eventCount,
			lastSeq: this.lastSeq,
			lastEvent: this.lastEvent,
			tail: this.tail,
			...extra,
		};
	}
}

/** Normalize one todo item to the two fields that matter. */
function normalizeTodo(todo) {
	return {
		content: typeof todo?.content === "string" ? todo.content : String(todo?.content ?? ""),
		status: todo?.status === "in_progress" || todo?.status === "completed" ? todo.status : "pending",
	};
}

/** Flatten message content blocks to plain text. */
function blocksToText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "string") return block;
			if (block?.type === "text" && typeof block.text === "string") return block.text;
			if (block?.type === "tool-call") return `[tool-call ${String(block.name ?? "")}]`;
			if (block?.type === "tool-result") return "[tool-result]";
			return "";
		})
		.filter((part) => part !== "")
		.join("\n");
}

/** Trim a value to a character budget, appending an ellipsis marker when cut. */
function clampText(value, limit) {
	const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** A short, printable summary of one event for the tail. */
function summarizeEvent(event) {
	const data = event.data ?? {};
	switch (event.type) {
		case "todo/write": {
			const todos = Array.isArray(data.todos) ? data.todos : [];
			const active = todos.filter((todo) => todo.status === "in_progress").length;
			return `${String(todos.length)} todos (${String(active)} in_progress)`;
		}
		case "tool/call":
			return `${String(data.name ?? "?")} ${clampText(data.arguments ?? "", 120)}`;
		case "tool/result":
			return clampText(blocksToText(data.message?.content), 120);
		case "user/message":
			return clampText(blocksToText(data.content), 160);
		case "assistant/message":
			return clampText(blocksToText(data.message?.content), 160);
		case "goal/change":
			return `${String(data.operation ?? "?")} ${clampText(data.goal?.objective ?? "", 120)}`;
		default:
			return "";
	}
}

/**
 * Render the human-readable resume brief: what was in flight, what the todo list
 * said, and how to pick the work up. Written next to the JSON snapshot so a human
 * (or the next session) can continue without decoding JSON.
 * @param snapshot - a {@link TaskSnapshot} serialization.
 * @returns markdown text.
 */
export function renderResumeBrief(snapshot) {
	const lines = [];
	const counts = snapshot.todoCounts ?? {};
	lines.push("# dsh-guard 任务快照");
	lines.push("");
	lines.push(`- 会话: \`${String(snapshot.sessionId ?? "?")}\``);
	lines.push(`- 工作目录: \`${String(snapshot.cwd ?? "?")}\``);
	lines.push(`- 快照时间: ${String(snapshot.updatedAt ?? "?")}`);
	lines.push(`- 中断状态: ${snapshot.interrupted === true ? "**任务执行中被中断**" : "空闲时保存"}`);
	lines.push(`- 轮次/步骤: turn=${String(snapshot.turn ?? "-")} step=${String(snapshot.step ?? "-")}`);
	if (snapshot.crash !== undefined && snapshot.crash !== null) {
		lines.push(`- 上次退出: ${String(snapshot.crash.reason ?? "?")} — ${String(snapshot.crash.detail ?? "")}`);
	}
	lines.push("");
	lines.push(
		`## 任务列表（${String(counts.completed ?? 0)} 完成 / ${String(counts.inProgress ?? 0)} 进行中 / ${String(counts.pending ?? 0)} 待办）`,
	);
	lines.push("");
	if (Array.isArray(snapshot.todos) && snapshot.todos.length > 0) {
		for (const todo of snapshot.todos) {
			const mark = todo.status === "completed" ? "x" : todo.status === "in_progress" ? "→" : " ";
			lines.push(`- [${mark}] ${todo.content}`);
		}
	} else {
		lines.push("（本次会话没有调用过 todo_write，没有可恢复的任务列表）");
	}
	lines.push("");
	if (snapshot.goal !== null && snapshot.goal !== undefined) {
		lines.push("## 目标");
		lines.push("");
		lines.push(`- ${String(snapshot.goal.objective ?? "")}`);
		lines.push(`- 状态: ${String(snapshot.goal.phase ?? "-")}`);
		lines.push("");
	}
	if (Array.isArray(snapshot.openToolCalls) && snapshot.openToolCalls.length > 0) {
		lines.push("## 崩溃时未收到结果的工具调用");
		lines.push("");
		for (const call of snapshot.openToolCalls) {
			lines.push(`- \`${String(call.name ?? "?")}\` ${String(call.arguments ?? "")}`);
		}
		lines.push("");
	}
	if (typeof snapshot.lastUserMessage === "string" && snapshot.lastUserMessage !== "") {
		lines.push("## 最后一条人类指令");
		lines.push("");
		lines.push("```text");
		lines.push(snapshot.lastUserMessage);
		lines.push("```");
		lines.push("");
	}
	if (typeof snapshot.lastAssistantText === "string" && snapshot.lastAssistantText !== "") {
		lines.push("## 中断前的最后一段助手输出");
		lines.push("");
		lines.push("```text");
		lines.push(snapshot.lastAssistantText);
		lines.push("```");
		lines.push("");
	}
	lines.push("## 继续方式");
	lines.push("");
	lines.push("把这份快照（或上面的任务列表）交给 agent，然后说：");
	lines.push("");
	lines.push("> 这是崩溃前的任务快照，接着把未完成的部分做完。");
	lines.push("");
	return lines.join("\n");
}

/**
 * Render the autoResume prompt: the template's `{{snapshot}}` placeholder is
 * replaced by a token-cheap but complete rendering of the saved task state.
 * @param template - the configured prompt template.
 * @param snapshot - the snapshot the watchdog left behind.
 * @param request - the watchdog's resume request (carries the crash verdict).
 * @returns the prompt text.
 */
export function renderResumePrompt(template, snapshot, request) {
	const counts = snapshot.todoCounts ?? {};
	const lines = [];
	lines.push(`- 会话: ${String(snapshot.sessionId ?? "?")}`);
	lines.push(`- 工作目录: ${String(snapshot.cwd ?? "?")}`);
	lines.push(`- 快照时间: ${String(snapshot.updatedAt ?? "?")}`);
	lines.push(`- 中断位置: turn=${String(snapshot.turn ?? "-")} step=${String(snapshot.step ?? "-")}`);
	lines.push(`- 上次退出原因: ${String(request?.reason ?? snapshot.crash?.reason ?? "未知")}`);
	lines.push(
		`- 任务列表: ${String(counts.completed ?? 0)} 完成 / ${String(counts.inProgress ?? 0)} 进行中 / ${String(counts.pending ?? 0)} 待办`,
	);
	lines.push("");
	lines.push("任务列表：");
	if (Array.isArray(snapshot.todos) && snapshot.todos.length > 0) {
		for (const todo of snapshot.todos) {
			const mark = todo.status === "completed" ? "x" : todo.status === "in_progress" ? "→" : " ";
			lines.push(`- [${mark}] ${todo.content}`);
		}
	} else {
		lines.push("- （本会话没有 todo_write 记录）");
	}
	if (snapshot.goal !== null && snapshot.goal !== undefined) {
		lines.push("");
		lines.push(`目标：${String(snapshot.goal.objective ?? "")}`);
	}
	if (Array.isArray(snapshot.openToolCalls) && snapshot.openToolCalls.length > 0) {
		lines.push("");
		lines.push("中断时未收到结果的工具调用（重做前先确认它们是否已经生效）：");
		for (const call of snapshot.openToolCalls) lines.push(`- ${String(call.name ?? "?")} ${String(call.arguments ?? "")}`);
	}
	if (typeof snapshot.lastUserMessage === "string" && snapshot.lastUserMessage !== "") {
		lines.push("");
		lines.push("最后一条人类指令：");
		lines.push("```text");
		lines.push(snapshot.lastUserMessage.slice(0, 1200));
		lines.push("```");
	}
	lines.push("");
	lines.push(`完整快照文件: ${String(request?.snapshotPath ?? "snapshot.json")}`);
	return template.replaceAll("{{snapshot}}", lines.join("\n"));
}

/**
 * Deliver one autoResume prompt into the interrupted session. The agent for a
 * Web session is created on demand when the browser attaches, so this retries
 * with a bounded budget instead of assuming the agent already exists.
 * @param ctx - the plugin context (uses the optional `agents` service).
 * @param options - resolved plugin options.
 * @param deps - `{ log }` sink for diagnostics.
 */
export function scheduleAutoResume(ctx, options, deps) {
	const requestPath = join(options.stateDir, "resume-request.json");
	const request = readJson(requestPath);
	if (request === undefined || request === null) return;
	const snapshot = readJson(join(options.stateDir, "snapshot.json"));
	if (snapshot === undefined || snapshot === null) {
		remove(requestPath);
		return;
	}
	const sessionId = request.sessionId ?? snapshot.sessionId;
	if (typeof sessionId !== "string" || sessionId === "") {
		remove(requestPath);
		return;
	}
	const prompt = renderResumePrompt(options.resumePrompt, snapshot, request);
	const deadline = Date.now() + 60_000;
	let timer = null;
	const attempt = () => {
		const agents = ctx.get("agents");
		const agent = agents?.get?.(sessionId);
		if (agent !== undefined && typeof agent.followup === "function") {
			try {
				agent.followup({ role: "user", content: [{ type: "text", text: prompt }] });
				remove(requestPath);
				deps.log(`guard: autoResume delivered into session ${sessionId}`);
			} catch (error) {
				remove(requestPath);
				deps.log(`guard: autoResume delivery failed for ${sessionId}: ${describeError(error)}`);
			}
			return;
		}
		if (Date.now() > deadline) {
			remove(requestPath);
			deps.log(`guard: autoResume gave up waiting for agent ${sessionId} (no Web client attached)`);
			return;
		}
		timer = setTimeout(attempt, 2000);
		timer.unref?.();
	};
	// The Web client attaches after boot; give it a moment, then start probing.
	timer = setTimeout(attempt, 1500);
	timer.unref?.();
}

// ---------------------------------------------------------------------------
// Watchdog spawn
// ---------------------------------------------------------------------------

/** Absolute path of the watchdog script shipped beside this module. */
export function watchdogScript() {
	return fileURLToPath(new URL("../bin/watchdog.mjs", import.meta.url));
}

/**
 * The command line that relaunches this exact dsh. `process.argv[1]` is the dsh
 * entry script when dsh is launched as `node <bin.js> ...`, so the pair
 * (execPath, argv.slice(1)) rebuilds the invocation without guessing at PATH
 * shims.
 * @returns `{ execPath, args }` for the watchdog's child spawn.
 */
export function invocationOf() {
	return { execPath: process.execPath, args: process.argv.slice(1) };
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/**
 * Register the guard: state files, crash recorders, HTTP routes, the session
 * snapshot fold, and the detached watchdog.
 * @param ctx - plugin context carrying `webServer` (and optionally `loader`).
 * @param rawConfig - the row config (see {@link resolveOptions}).
 */
export function apply(ctx, rawConfig) {
	const options = resolveOptions(rawConfig);
	const startedAt = Date.now();
	const state = {
		quitting: false,
		crashing: false,
		sessions: new Map(),
		lastCrash: readJson(join(options.stateDir, FILES.crash)),
		watchdog: { enabled: options.watchdog, status: "pending" },
		flushTimer: null,
	};

	mkdirSync(options.stateDir, { recursive: true });
	mkdirSync(join(options.stateDir, "sessions"), { recursive: true });
	remove(join(options.stateDir, FILES.stop));
	remove(join(options.stateDir, FILES.cleanExit));

	const pathOf = (key) => join(options.stateDir, FILES[key]);
	const port = () => ctx.get("webServer")?.port ?? null;

	// -- diagnostics --------------------------------------------------------
	const statusSnapshot = () => {
		const sessions = [...state.sessions.values()].map((entry) => entry.snapshot.toJSON());
		const active = sessions.find((session) => session.interrupted === true) ?? sessions[sessions.length - 1];
		return {
			schema: "dsh-guard/status@1",
			pid: process.pid,
			port: port(),
			host: ctx.get("webServer")?.host ?? null,
			startedAt: new Date(startedAt).toISOString(),
			uptimeMs: Date.now() - startedAt,
			node: process.version,
			platform: process.platform,
			execPath: process.execPath,
			argv: process.argv.slice(1),
			cwd: process.cwd(),
			quitting: state.quitting,
			watchdog: state.watchdog,
			lastCrash: state.lastCrash ?? null,
			options: {
				stateDir: options.stateDir,
				watchdog: options.watchdog,
				autoResume: options.autoResume,
				restartDelayMs: options.restartDelayMs,
				maxRestarts: options.maxRestarts,
				crashWindowMs: options.crashWindowMs,
			},
			sessions: sessions.map((session) => ({
				sessionId: session.sessionId,
				phase: session.phase,
				interrupted: session.interrupted,
				updatedAt: session.updatedAt,
				todos: session.todoCounts,
			})),
			activeSessionId: active?.sessionId ?? null,
			interrupted: active?.interrupted === true,
			snapshotPath: pathOf("snapshot"),
			resumePath: pathOf("resume"),
			crashPath: pathOf("crash"),
		};
	};

	const flushStatus = () => writeJson(pathOf("status"), statusSnapshot());

	// -- instance registry (what the external autostart task reads) ---------
	const invocation = invocationOf();
	const writeInstance = (extra = {}) =>
		writeJson(pathOf("instance"), {
			schema: "dsh-guard/instance@1",
			pid: process.pid,
			port: port(),
			cwd: process.cwd(),
			execPath: invocation.execPath,
			args: invocation.args,
			// The absolute watchdog path is recorded here so an external safety
			// net (guard-autostart.ps1) can restart the watchdog without knowing
			// anything about where dsh-guard was installed.
			watchdogScript: watchdogScript(),
			startedAt: new Date(startedAt).toISOString(),
			updatedAt: new Date().toISOString(),
			watchdog: state.watchdog,
			options: { stateDir: options.stateDir, autoResume: options.autoResume },
			...extra,
		});
	// -- snapshot flush (defined before the crash paths that call it) -------
	const flushSnapshots = (extra = {}) => {
		const sessions = [...state.sessions.values()].map((entry) => entry.snapshot.toJSON(extra));
		if (sessions.length === 0) return;
		const active = sessions.find((session) => session.interrupted === true) ?? sessions[sessions.length - 1];
		try {
			writeJson(pathOf("snapshot"), active);
			writeFileSync(pathOf("resume"), renderResumeBrief(active), "utf8");
		} catch {
			/* snapshot writing is best-effort by design */
		}
		writeJson(pathOf("refs"), {
			schema: "dsh-guard/refs@1",
			updatedAt: new Date().toISOString(),
			sessions: sessions.map((session) => ({
				sessionId: session.sessionId,
				cwd: session.cwd,
				phase: session.phase,
				interrupted: session.interrupted,
				updatedAt: session.updatedAt,
			})),
		});
		flushStatus();
		writeInstance();
	};

	/** Best-effort snapshot retention: keep the newest `keepSessions` per-session files. */
	const pruneSnapshots = () => {
		const dir = join(options.stateDir, "sessions");
		const entries = listFiles(dir).filter((entry) => entry.name.endsWith(".json"));
		entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
		for (const stale of entries.slice(options.keepSessions)) {
			try {
				rmSync(join(dir, stale.name), { force: true });
			} catch {
				/* a locked snapshot is pruned on a later run */
			}
		}
	};

	const scheduleFlush = () => {
		if (state.flushTimer !== null) return;
		const timer = setTimeout(() => {
			state.flushTimer = null;
			try {
				flushSnapshots();
			} catch (error) {
				ctx.logger?.warn?.(`guard: snapshot flush failed: ${describeError(error)}`);
			}
		}, 400);
		timer.unref?.();
		state.flushTimer = timer;
	};

	// -- crash recording ----------------------------------------------------
	const recordCrash = (reason, detail, error) => {
		if (state.crashing) return;
		state.crashing = true;
		const record = {
			schema: "dsh-guard/crash@1",
			at: new Date().toISOString(),
			pid: process.pid,
			port: port(),
			uptimeMs: Date.now() - startedAt,
			reason,
			detail,
			error: error === undefined ? null : describeError(error),
			stack: error === undefined ? null : stackOf(error),
			sessions: [...state.sessions.values()].map((entry) => entry.snapshot.toJSON()),
			invocation,
		};
		writeJson(pathOf("crash"), record);
		appendLine(pathOf("crashLog"), `${record.at}\t${reason}\t${detail}\t${record.stack ?? "-"}`);
		try {
			flushSnapshots({ crash: { reason, detail, at: record.at } });
		} catch {
			/* the crash record itself is already on disk */
		}
		state.lastCrash = record;
		flushStatus();
	};

	process.on("uncaughtException", (error) => {
		// Observe only: Cordis (or the platform default) still owns termination,
		// so dsh-guard changes nothing about exit codes — it only removes silence.
		recordCrash("uncaughtException", describeError(error), error);
	});
	process.on("unhandledRejection", (reason) => {
		const error = reason instanceof Error ? reason : new Error(String(reason));
		recordCrash("unhandledRejection", describeError(error), error);
	});
	process.on("warning", (warning) => {
		appendLine(pathOf("crashLog"), `${new Date().toISOString()}\twarning\t${describeError(warning)}\t${warning?.stack ?? "-"}`);
	});
	process.on("exit", (code) => {
		if (!state.quitting && code !== 0) {
			recordCrash("exit", `window exited with code ${String(code)}`, undefined);
		} else {
			appendLine(
				pathOf("crashLog"),
				`${new Date().toISOString()}\texit\t${state.quitting ? "graceful quit through dsh-guard" : `code ${String(code)}`}`,
			);
		}
		writeJson(pathOf("status"), { ...statusSnapshot(), exitedAt: new Date().toISOString(), exitCode: code });
	});

	// -- session fold -------------------------------------------------------
	ctx.on("session/event", (session, event) => {
		const sessionId = session?.id;
		if (typeof sessionId !== "string" || sessionId === "") return;
		let entry = state.sessions.get(sessionId);
		if (entry === undefined) {
			entry = { snapshot: new TaskSnapshot(sessionId, session?.header?.cwd) };
			state.sessions.set(sessionId, entry);
		}
		try {
			entry.snapshot.apply(event);
			entry.snapshot.trim(options.tailEvents);
		} catch (error) {
			ctx.logger?.warn?.(`guard: snapshot fold failed for ${sessionId}: ${describeError(error)}`);
			return;
		}
		const significant =
			event.type === "todo/write" || event.type === "turn/end" || event.type === "turn/start" || event.type === "goal/change";
		if (significant) {
			try {
				flushSnapshots();
				writeJson(join(options.stateDir, "sessions", `${safeName(sessionId)}.json`), entry.snapshot.toJSON());
				pruneSnapshots();
			} catch (error) {
				ctx.logger?.warn?.(`guard: snapshot write failed: ${describeError(error)}`);
			}
		} else {
			scheduleFlush();
		}
	});

	// -- graceful shutdown --------------------------------------------------
	const shutdown = (code) => {
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			try {
				flushSnapshots();
				flushStatus();
				writeInstance({ exited: true, exitCode: code });
			} catch {
				/* nothing left to protect */
			}
			process.exit(code);
		};
		const timer = setTimeout(finish, options.timeoutMs);
		timer.unref?.();
		Promise.resolve()
			.then(() => ctx.get("loader")?.stop?.())
			.catch((error) => {
				appendLine(pathOf("crashLog"), `${new Date().toISOString()}\tshutdown-error\t${describeError(error)}`);
			})
			.finally(() => {
				clearTimeout(timer);
				finish();
			});
	};

	// -- HTTP surface -------------------------------------------------------
	const sendJson = (res, status, value) => {
		const body = JSON.stringify(value, null, 2);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"content-length": Buffer.byteLength(body),
		});
		res.end(body);
	};

	const serve = (path, handler) =>
		ctx.effect(
			() =>
				ctx.webServer.register({
					kind: "exact",
					path,
					handler: (req, res) => {
						if (req.method !== "GET" && req.method !== "POST") {
							sendJson(res, 405, { ok: false, error: "method not allowed" });
							return;
						}
						try {
							handler(req, res);
						} catch (error) {
							sendJson(res, 500, { ok: false, error: describeError(error) });
						}
					},
				}),
			`guard: ${path}`,
		);

	serve(STATUS_PATH, (_req, res) => sendJson(res, 200, { ok: true, ...statusSnapshot() }));

	serve(SNAPSHOT_PATH, (_req, res) =>
		sendJson(res, 200, {
			ok: true,
			snapshot: readJson(pathOf("snapshot")) ?? null,
			resume: readTextFile(pathOf("resume")) ?? null,
		}),
	);

	serve(CRASH_PATH, (_req, res) =>
		sendJson(res, 200, {
			ok: true,
			crash: readJson(pathOf("crash")) ?? null,
			log: readCrashTail(pathOf("crashLog"), 40),
		}),
	);

	serve(QUIT_PATH, (_req, res) => {
		if (state.quitting) {
			sendJson(res, 202, { ok: true, alreadyQuitting: true });
			return;
		}
		state.quitting = true;
		state.watchdog = { ...state.watchdog, stopped: true, reason: "user quit" };
		const at = new Date().toISOString();
		writeJson(pathOf("cleanExit"), {
			schema: "dsh-guard/clean-exit@1",
			at,
			pid: process.pid,
			port: port(),
			reason: "quit button",
		});
		writeJson(pathOf("stop"), { at, reason: "quit button" });
		try {
			flushSnapshots();
			flushStatus();
		} catch {
			/* the clean-exit marker is already down */
		}
		sendJson(res, 200, { ok: true, quitting: true, at });
		ctx.logger?.info?.("guard: quit requested from the Web UI; disposing the tree");
		shutdown(0);
	});

	// -- watchdog -----------------------------------------------------------
	if (options.watchdog) {
		queueMicrotask(() => {
			try {
				const script = watchdogScript();
				if (!existsSync(script)) throw new Error(`watchdog script missing at ${script}`);
				const child = spawn(
					process.execPath,
					[
						script,
						"--state-dir",
						options.stateDir,
						"--parent-pid",
						String(process.pid),
						"--delay-ms",
						String(options.restartDelayMs),
						"--max-restarts",
						String(options.maxRestarts),
						"--window-ms",
						String(options.crashWindowMs),
						"--port-conflict",
						options.portConflict,
						"--rapid-death-ms",
						String(options.rapidDeathMs),
						"--max-rapid-restarts",
						String(options.maxRapidRestarts),
					],
					{
						// detached + unref is what makes the watchdog outlive this
						// process: it is a separate process that merely was started here.
						detached: true,
						stdio: "ignore",
						windowsHide: true,
						cwd: process.cwd(),
						env: process.env,
					},
				);
				child.unref();
				state.watchdog = {
					enabled: true,
					status: "running",
					pid: child.pid ?? null,
					script,
					autoResume: options.autoResume,
				};
				writeJson(pathOf("watchdogPid"), { pid: child.pid ?? null, at: new Date().toISOString(), stateDir: options.stateDir });
				ctx.logger?.info?.(`guard: watchdog started (pid ${String(child.pid ?? "?")}) for state ${options.stateDir}`);
			} catch (error) {
				state.watchdog = { enabled: true, status: "failed", error: describeError(error) };
				ctx.logger?.warn?.(`guard: watchdog failed to start: ${describeError(error)}`);
			}
			flushStatus();
			writeInstance();
		});
	} else {
		state.watchdog = { enabled: false, status: "disabled" };
	}

	ctx.logger?.info?.(
		`guard: state ${options.stateDir}; quit on ${QUIT_PATH}; watchdog ${options.watchdog ? "on" : "off"}; autoResume ${options.autoResume ? "on" : "off"}`,
	);

	flushStatus();
	writeInstance();
	// A heartbeat, so an instance record cannot be mistaken for a live dsh: the
	// external autostart task refuses to act on a record that stopped being
	// refreshed, which is also what happens after a hard kill of the whole tree.
	const heartbeat = setInterval(() => {
		if (state.quitting) return;
		writeInstance();
	}, 30_000);
	heartbeat.unref?.();
	if (options.autoResume) {
		scheduleAutoResume(ctx, options, { log: (message) => ctx.logger?.info?.(message) });
	}
	ctx.effect(
		() => () => {
			try {
				flushSnapshots();
				flushStatus();
			} catch {
				/* shutting down */
			}
		},
		"guard: final flush",
	);
}
