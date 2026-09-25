#!/usr/bin/env node
/**
 * Test fixture: a fake "incumbent dsh guard" listening on one port.
 *
 * Answers `/dsh-guard/status` with the pid given on the command line, which is
 * what the watchdog probes to decide whether the dsh it guards is still serving.
 * Exits after `--answers` probes (or on stdin close) so it cannot outlive a test.
 *
 * Usage: node mock-guard-status.mjs <port> <pid> [--answers N]
 */
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const pid = Number(process.argv[3]);
const answersIndex = process.argv.indexOf("--answers");
const maxAnswers = answersIndex === -1 ? 1 : Number(process.argv[answersIndex + 1]);

let served = 0;
const server = createServer((request, response) => {
	if (request.url === undefined || !request.url.startsWith("/dsh-guard/status")) {
		response.writeHead(404).end();
		return;
	}
	const body = JSON.stringify({ ok: true, schema: "dsh-guard/status@1", pid, port });
	response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
	response.end(body);
	served += 1;
	if (served >= maxAnswers) setTimeout(() => process.exit(0), 250);
});

server.listen(port, "127.0.0.1", () => {
	process.stdout.write(`mock guard status on ${String(port)} claiming pid ${String(pid)}\n`);
});
