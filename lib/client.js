/**
 * dsh-guard — browser half.
 *
 * Evaluated by the client module kernel as a plain (non-JSX, non-TypeScript)
 * async function body that receives `React` and `console` and must `return` a
 * Cordis plugin. It registers one entry into the sidebar's
 * `sidebar.footer.action` seat — the row the sidebar renders beside the Settings
 * button — and that entry is the Quit control.
 *
 * Behaviour:
 *   - one click arms the button ("再点一次"), a second click within 3s quits;
 *   - quitting POSTs `/dsh-guard/quit`, which makes the host write the watchdog's
 *     clean-exit marker, drain the session logs, and end the process;
 *   - the button then polls `/dsh-guard/status` and reloads the page once dsh is
 *     listening again, so a watchdog restart returns you to the same GUI;
 *   - while a task is marked interrupted (or the last death was a crash) the
 *     row grows a marker whose tooltip carries the crash reason and the path of
 *     the resume snapshot.
 *
 * All text is Chinese, matching how this dsh installation is used.
 */
return {
	name: "guard-client",
	inject: ["slots"],
	apply(ctx) {
		const STATUS_PATH = "/dsh-guard/status";
		const QUIT_PATH = "/dsh-guard/quit";
		const POLL_MS = 15000;
		const ARM_MS = 3000;
		const RETURN_POLL_MS = 1000;
		const RETURN_TIMEOUT_MS = 120000;

		/** One GET/POST against a same-origin dsh-guard route. */
		async function call(path, method) {
			const response = await fetch(path, {
				method: method || "GET",
				headers: { accept: "application/json" },
				cache: "no-store",
				credentials: "same-origin",
			});
			const body = await response.json().catch(() => undefined);
			if (body === undefined) throw new Error("HTTP " + String(response.status));
			return body;
		}

		/** Compact one-line summary of a watchdog state object. */
		function watchdogText(watchdog) {
			if (!watchdog) return "未启动";
			if (watchdog.status === "running") return "运行中 (pid " + String(watchdog.pid) + ")";
			if (watchdog.status === "disabled") return "未启用";
			if (watchdog.status === "failed") return "启动失败：" + String(watchdog.error);
			if (watchdog.stopped === true) return "已随退出停止";
			return String(watchdog.status);
		}

		/** The tooltip: everything a person needs to judge whether it is safe to quit. */
		function tooltip(status, quitting) {
			if (quitting) return "正在退出 dsh…";
			if (status === undefined) return "dsh-guard：状态读取中…";
			if (status.ok !== true) return "dsh-guard：状态路由不可用";
			const lines = [];
			lines.push("退出 dsh（先点一次确认，再点一次执行）");
			lines.push("会话: " + String(status.activeSessionId || "无"));
			lines.push("看门狗: " + watchdogText(status.watchdog));
			const active = status.sessions && status.sessions.find(function (session) {
				return session.interrupted === true;
			});
			if (active) lines.push("有任务执行中被中断；快照: " + String(status.snapshotPath || ""));
			if (status.lastCrash) {
				lines.push("上次异常退出: " + String(status.lastCrash.reason) + " — " + String(status.lastCrash.detail || ""));
				lines.push("退出时间: " + String(status.lastCrash.at));
				lines.push("崩溃记录: " + String(status.crashPath || ""));
			}
			if (status.options && status.options.autoResume === true) lines.push("重启后自动续跑: 开");
			lines.push("dsh 退出 = 该端口上的服务与看门狗一起停止");
			return lines.join("\n");
		}

		/** The row: quit control plus an interruption marker. */
		function GuardAction(props) {
			const wide = props.wide !== false;
			const [status, setStatus] = React.useState(undefined);
			const [armed, setArmed] = React.useState(false);
			const [quitting, setQuitting] = React.useState(false);
			const [note, setNote] = React.useState("");
			const timer = React.useRef(undefined);
			const alive = React.useRef(true);

			React.useEffect(function () {
				alive.current = true;
				let cancelled = false;
				async function poll() {
					try {
						const body = await call(STATUS_PATH);
						if (!cancelled) setStatus(body);
					} catch (error) {
						if (!cancelled) setStatus({ ok: false, error: String(error && error.message ? error.message : error) });
					}
				}
				poll();
				const handle = setInterval(function () {
					if (document.visibilityState === "hidden") return;
					poll();
				}, POLL_MS);
				return function () {
					cancelled = true;
					alive.current = false;
					clearInterval(handle);
					if (timer.current !== undefined) clearTimeout(timer.current);
				};
			}, []);

			function disarm() {
				setArmed(false);
				if (timer.current !== undefined) {
					clearTimeout(timer.current);
					timer.current = undefined;
				}
			}

			async function quit() {
				setQuitting(true);
				setNote("正在退出…");
				disarm();
				try {
					await call(QUIT_PATH, "POST");
				} catch (error) {
					// The socket closing mid-response is the expected shape of a
					// successful shutdown; only a body that says otherwise matters.
					/* the process may already be gone */
				}
				setNote("等待 dsh 退出…");
				const deadline = Date.now() + RETURN_TIMEOUT_MS;
				const tick = setInterval(async function () {
					if (Date.now() > deadline) {
						clearInterval(tick);
						setNote("dsh 未在超时时间内回来");
						setQuitting(false);
						return;
					}
					try {
						const body = await call(STATUS_PATH);
						if (body && body.ok === true) {
							clearInterval(tick);
							window.location.reload();
						}
					} catch (error) {
						setNote("dsh 已停止，等待看门狗拉起…");
					}
				}, RETURN_POLL_MS);
			}

			function onClick() {
				if (quitting) return;
				if (!armed) {
					setArmed(true);
					timer.current = setTimeout(disarm, ARM_MS);
					return;
				}
				quit();
			}

			const interrupted = status !== undefined && status.ok === true && status.interrupted === true;
			const crashed = status !== undefined && status.ok === true && status.lastCrash !== null && status.lastCrash !== undefined;
			const tone = quitting ? "#d29922" : armed ? "#f85149" : "inherit";

			const children = [];
			children.push(
				React.createElement(
					"span",
					{ key: "glyph", style: { fontSize: "14px", lineHeight: 1, flex: "none" } },
					quitting ? "…" : "⏻",
				),
			);
			if (wide || armed || quitting) {
				children.push(
					React.createElement(
						"span",
						{ key: "label", style: { whiteSpace: "nowrap" } },
						quitting ? note || "正在退出…" : armed ? "再点一次退出" : "退出",
					),
				);
			}
			if (interrupted || crashed) {
				children.push(
					React.createElement("span", {
						key: "dot",
						title: interrupted ? "有任务被中断，快照已保存" : "上次为异常退出",
						style: {
							width: "6px",
							height: "6px",
							borderRadius: "50%",
							flex: "none",
							background: interrupted ? "#d29922" : "#8b949e",
						},
					}),
				);
			}

			return React.createElement(
				"button",
				{
					type: "button",
					onClick: onClick,
					title: tooltip(status, quitting),
					"aria-label": quitting ? "正在退出 dsh" : armed ? "再点一次以退出 dsh" : "退出 dsh",
					"data-dsh-guard": quitting ? "quitting" : armed ? "armed" : "idle",
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: wide ? "flex-start" : "center",
						gap: "6px",
						width: "100%",
						padding: wide ? "6px 8px" : "6px 0",
						border: "1px solid transparent",
						borderRadius: "6px",
						background: "transparent",
						color: tone,
						font: "inherit",
						cursor: quitting ? "default" : "pointer",
						textAlign: "left",
					},
				},
				children,
			);
		}

		ctx.slots.inject("sidebar.footer.action", function () {
			return ctx.slots.register({ name: "sidebar.footer.action", id: "guard-quit", order: 100 }, GuardAction);
		});
	},
};
