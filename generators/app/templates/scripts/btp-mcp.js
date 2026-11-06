#!/usr/bin/env node
/*
 * Starts a tool that needs the btp-proxy (e.g. an ABAP Development Tools MCP server) once the proxy of an
 * environment answers. Claude Code starts MCP servers on its own, in no particular order and without a terminal,
 * so the dependency lives here:
 *
 *   node scripts/btp-mcp.js <env> -- <command> [args...]
 *
 * - A btp-proxy already serving the environment's destination on BTP_PROXY_PORT is reused (it is shared by every
 *   session and outlives them).
 * - Otherwise one is started in the background, detached, with its log in <os temp>/btp-proxy-<project>-<env>.log.
 *   An expired cf session is renewed there with the environment's user and password variable (cf auth); with
 *   single sign-on, run `cf login --sso` first.
 * - Then <command> runs with stdin / stdout untouched (MCP talks over them) and its exit code is passed on.
 *
 * Messages go to stderr only: stdout belongs to the MCP protocol.
 */
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { ROOT, loadProfile } = require("./btp-env");

const say = (msg) => process.stderr.write(`[btp-mcp] ${msg}\n`);
const sep = process.argv.indexOf("--");
const own = sep > 0 ? process.argv.slice(2, sep) : process.argv.slice(2);
const command = sep > 0 ? process.argv.slice(sep + 1) : [];
if (!command.length) {
	say("usage: node scripts/btp-mcp.js <env> -- <command> [args...]");
	process.exit(2);
}

let profile;
try {
	profile = loadProfile(own[0]);
} catch (e) {
	say(e.message);
	process.exit(1);
}
const port = Number(process.env.BTP_PROXY_PORT || 5050);
const destination = process.env.BTP_DESTINATION;
const waitSeconds = Number(process.env.BTP_MCP_WAIT || 40);

function health() {
	return new Promise((resolve) => {
		const req = http.get({ host: "127.0.0.1", port, path: "/__btp-proxy/health", timeout: 2000 }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => {
				try {
					resolve(JSON.parse(body));
				} catch (e) {
					resolve("foreign");
				}
			});
		});
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(undefined));
	});
}

const ours = (h) => h && h !== "foreign" && h.destination === destination && h.app === process.env.BTP_APP;

async function ensureProxy() {
	const h = await health();
	if (ours(h)) return say(`reusing btp-proxy on :${port} (${destination})`);
	if (h) return say(`port ${port} is taken by something else, not touching it - the tool will tell whether it reaches the right system`);
	const log = path.join(os.tmpdir(), `btp-proxy-${path.basename(ROOT).replace(/\W+/g, "_")}-${profile || "default"}.log`);
	say(`starting btp-proxy for ${destination} on :${port} (log ${log})`);
	const out = fs.openSync(log, "a");
	const proxy = spawn(process.execPath, [path.join(__dirname, "btp-proxy.js"), ...(profile ? ["--profile", profile] : [])], {
		cwd: ROOT,
		detached: true,
		stdio: ["ignore", out, out],
		windowsHide: true
	});
	proxy.unref();
	for (let i = 0; i < waitSeconds * 2; i++) {
		await new Promise((r) => setTimeout(r, 500));
		if (ours(await health())) return say(`btp-proxy ready after ${Math.round(i / 2)}s`);
		if (proxy.exitCode !== null) break;
	}
	say(`btp-proxy not ready - starting the tool anyway, see ${log} (cf session expired without a password variable? single sign-on needs cf login --sso first)`);
}

ensureProxy().then(() => {
	// Windows: an .exe runs as is; anything else (a .cmd / .bat shim, a name found through PATHEXT) needs the shell,
	// with the arguments quoted for cmd so paths with spaces (C:\Program Files\...) survive
	const viaShell = process.platform === "win32" && !/\.(exe|com)$/i.test(command[0]);
	const quote = (a) => (/^[\w\-.\/\\:=@,+]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`);
	const child = viaShell
		? spawn(command.map(quote).join(" "), { stdio: "inherit", shell: true })
		: spawn(command[0], command.slice(1), { stdio: "inherit" });
	child.on("exit", (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code));
	child.on("error", (e) => {
		say(`${command[0]}: ${e.message}`);
		process.exit(1);
	});
	for (const sig of /** @type {NodeJS.Signals[]} */ (["SIGINT", "SIGTERM"])) process.on(sig, () => child.kill(sig));
});
