"use strict";
/*
 * Scenario tests of the generated scripts and the ADT helpers, with a fake cf CLI and fake BTP services
 * (test/fakes). They run the real scripts/btp-env.js, btp-proxy.js and btp-mcp.js as child processes, on Windows,
 * macOS and Linux:
 *
 *   login   cf login without a terminal: user + password variable, rejected password remembered, SSO, targets
 *   proxy   end to end: destination lookup, connectivity headers, cookie priming, ADT virtualhost probe, https,
 *           tunnel dropped and reopened with a new login
 *   bas     Business Application Studio: dev space destination proxy and destination list, no cf at all
 *   mcp     btp-mcp.js reuses a running proxy, or starts one in the background, then runs the tool
 *   adt     adt-cert: localhost certificate, VS Code ADT JREs (Linux and macOS layouts), Eclipse, WSL paths
 *   apps    which apps of a space can carry the tunnel, and which of them are real applications
 *
 *   node test/scenarios.js [login|proxy|mcp|adt|apps ...]
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");

const isWin = process.platform === "win32";
const TEMPLATES = path.join(__dirname, "..", "generators", "app", "templates", "scripts");
const only = process.argv.slice(2);
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A folder with a `cf` (and `keytool`) that run the fakes, for PATH. */
function fakeBin(name, script, dir = tmp("btp-bin-")) {
	if (isWin) fs.writeFileSync(path.join(dir, `${name}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`);
	else fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
	return dir;
}

/** A fresh world: fake cf state, its own home (rejection markers, certificates) and a project with the scripts. */
function world(envFile = {}) {
	const cfDir = tmp("btp-cf-");
	const home = tmp("btp-home-");
	const project = tmp("btp-project-");
	fs.mkdirSync(path.join(project, "scripts"));
	for (const f of ["btp-env.js", "btp-proxy.js", "btp-mcp.js"]) fs.copyFileSync(path.join(TEMPLATES, f), path.join(project, "scripts", f));
	const values = { BTP_CF_API: "https://api.cf.eu10.hana.ondemand.com", BTP_CF_ORG: "my-org", BTP_CF_SPACE: "dev", BTP_APP: "my-srv", BTP_DESTINATION: "SYS", ...envFile };
	fs.writeFileSync(path.join(project, ".env.dev"), Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
	const bin = fakeBin("cf", path.join(__dirname, "fakes", "cf.js"));
	/** @type {NodeJS.ProcessEnv} */
	const env = {
		...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CF_|BTP_|FAKE_|EP_|H2O_URL$|https?_proxy$)/i.test(k))),
		PATH: `${bin}${path.delimiter}${process.env.PATH}`,
		FAKE_CF_DIR: cfDir,
		HOME: home,
		USERPROFILE: home,
		BTP_PROXY_TLS_DIR: path.join(home, "tls")
	};
	const state = (patch) => {
		const file = path.join(cfDir, "state.json");
		const now = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { api: "https://api.cf.eu10.hana.ondemand.com", authed: false, org: "my-org", space: "dev" };
		if (patch) fs.writeFileSync(file, JSON.stringify({ ...now, ...patch }));
		return now;
	};
	const calls = () => (fs.existsSync(path.join(cfDir, "calls.log")) ? fs.readFileSync(path.join(cfDir, "calls.log"), "utf8").trim().split(/\r?\n/).filter(Boolean) : []);
	const commands = () => calls().map((l) => l.split(" | ")[0]);
	const clearCalls = () => fs.writeFileSync(path.join(cfDir, "calls.log"), "");
	return { cfDir, home, project, env, state, calls, commands, clearCalls };
}

/** Runs ensureCfTarget of the project's btp-env.js, without a terminal, like a background proxy. */
function ensureTarget(w, extraEnv = {}) {
	const code = `require("./scripts/btp-env").loadProfile("dev"); require("./scripts/btp-env").ensureCfTarget({ interactive: true, log: (m) => console.log(m) })`;
	return spawnSync(process.execPath, ["-e", code], { cwd: w.project, env: { ...w.env, ...extraEnv }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/* ------------------------------------------------------------------ login */

function login() {
	const creds = { BTP_CF_USER: "me@example.org", BTP_CF_PASSWORD_ENV: "EP_CF_PASSWORD" };

	// expired session, nothing to log in with: the message says what to set
	let w = world();
	let r = ensureTarget(w);
	assert.notStrictEqual(r.status, 0);
	assert.match(r.stderr, /set CF_USERNAME and CF_PASSWORD, or run: cf login -a https:\/\/api\.cf\.eu10\.hana\.ondemand\.com -o my-org -s dev/);
	w = world({ BTP_CF_USER: "me@example.org" });
	assert.match(ensureTarget(w).stderr, /set CF_PASSWORD, or run/);

	// user and password variable of the environment: cf auth gets them as CF_USERNAME / CF_PASSWORD, then targets
	w = world(creds);
	r = ensureTarget(w, { EP_CF_PASSWORD: "good", CF_USERNAME: "someone@else", CF_PASSWORD: "other" });
	assert.strictEqual(r.status, 0, r.stderr);
	assert.deepStrictEqual(w.commands(), ["api", "target", "oauth-token", "api https://api.cf.eu10.hana.ondemand.com", "auth", "target -o my-org -s dev"]);
	assert.ok(w.calls().includes("auth | user=me@example.org | pw=set"));
	assert.match(r.stdout, /logging in as me@example\.org \(password from EP_CF_PASSWORD\)/);

	// a valid session in the right place: nothing else happens
	w.clearCalls();
	assert.strictEqual(ensureTarget(w, { EP_CF_PASSWORD: "good" }).status, 0);
	assert.deepStrictEqual(w.commands(), ["api", "target", "oauth-token"]);

	// valid session, other org: cf target only
	w.state({ org: "other-org" });
	w.clearCalls();
	assert.strictEqual(ensureTarget(w, { EP_CF_PASSWORD: "good" }).status, 0);
	assert.deepStrictEqual(w.commands(), ["api", "target", "oauth-token", "target -o my-org -s dev"]);

	// cf points at another region: log in there
	w.state({ api: "https://api.cf.us10.hana.ondemand.com" });
	w.clearCalls();
	assert.strictEqual(ensureTarget(w, { EP_CF_PASSWORD: "good" }).status, 0, "other region");
	assert.deepStrictEqual(w.commands(), ["api", "api https://api.cf.eu10.hana.ondemand.com", "auth", "target -o my-org -s dev"]);

	// custom identity provider
	w = world({ ...creds, BTP_CF_ORIGIN: "sap.custom" });
	assert.strictEqual(ensureTarget(w, { EP_CF_PASSWORD: "good" }).status, 0);
	assert.ok(w.commands().includes("auth --origin sap.custom"));

	// wrong password: rejected once, remembered (fingerprint only), never tried again with the same password
	w = world(creds);
	r = ensureTarget(w, { EP_CF_PASSWORD: "wrong-secret" });
	assert.notStrictEqual(r.status, 0);
	assert.match(r.stderr, /cf auth as me@example\.org failed: Credentials were rejected, please try again\./);
	assert.ok(!(r.stdout + r.stderr).includes("wrong-secret"), "no password in the output");
	const marker = path.join(w.home, ".cache", "btp-on-premise", "auth-rejected-me@example.org");
	assert.ok(fs.existsSync(marker), "rejection remembered");
	assert.ok(!fs.readFileSync(marker, "utf8").includes("wrong-secret"), "no password in the marker");
	w.clearCalls();
	r = ensureTarget(w, { EP_CF_PASSWORD: "wrong-secret" });
	assert.match(r.stderr, /rejected before with this password .* not trying again so the account does not get locked - update EP_CF_PASSWORD/);
	assert.ok(!w.commands().includes("auth"), "no second cf auth with the same password");
	// a new password is tried, and a success clears the marker
	w.clearCalls();
	assert.strictEqual(ensureTarget(w, { EP_CF_PASSWORD: "good" }).status, 0);
	assert.ok(w.commands().includes("auth") && !fs.existsSync(marker));

	// a network error is not a rejection: the next start tries again
	w = world(creds);
	r = ensureTarget(w, { EP_CF_PASSWORD: "net" });
	assert.match(r.stderr, /i\/o timeout/);
	w.clearCalls();
	ensureTarget(w, { EP_CF_PASSWORD: "net" });
	assert.ok(w.commands().includes("auth"), "retried after a network error");

	// logged in, but the org is wrong: a clear message, no interactive login
	w = world({ ...creds, BTP_CF_ORG: "bad-org" });
	r = ensureTarget(w, { EP_CF_PASSWORD: "good" });
	assert.match(r.stderr, /logged in as me@example\.org, but cf target -o "bad-org" -s "dev" failed: Organization 'bad-org' not found/);

	// single sign-on: the global credentials are never used
	w = world({ BTP_CF_SSO: "true" });
	r = ensureTarget(w, { CF_USERNAME: "me@example.org", CF_PASSWORD: "good" });
	assert.match(r.stderr, /run: cf login -a \S+ -o my-org -s dev --sso/);
	assert.ok(!w.commands().includes("auth"));

	// without settings in the environment, CF_USERNAME / CF_PASSWORD
	w = world();
	assert.strictEqual(ensureTarget(w, { CF_USERNAME: "me@example.org", CF_PASSWORD: "good" }).status, 0);
	console.log("OK login scenarios");
}

/* ------------------------------------------------------------------ proxy */

const freePort = () => new Promise((resolve) => {
	const s = net.createServer().listen(0, "127.0.0.1", () => {
		const { port } = /** @type {import("net").AddressInfo} */ (s.address());
		s.close(() => resolve(port));
	});
});
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const request = (url, options = {}) => new Promise((resolve, reject) => {
	const lib = url.startsWith("https") ? https : http;
	lib.get(url, { rejectUnauthorized: false, ...options }, (res) => {
		let body = "";
		res.on("data", (c) => (body += c));
		res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
	}).on("error", reject);
});
const waitFor = async (what, check, seconds = 30) => {
	for (let i = 0; i < seconds * 4; i++) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`timed out waiting for ${what}`);
};
const hasOpenssl = () => spawnSync("openssl", ["version"], { stdio: "ignore", shell: isWin }).status === 0;

/** Fake Destination service + connectivity proxy, and a world whose app is bound to them. */
async function btpWorld(envFile = {}) {
	const upstreamRequests = [];
	// the connectivity proxy: plain HTTP proxy semantics (absolute URL), the backend answers 401 without a logon
	const upstream = http.createServer((req, res) => {
		upstreamRequests.push({ url: req.url, headers: req.headers });
		// a static file the backend serves without a logon: no cookie at all
		if (!req.headers.authorization && String(req.url).includes("/sap/bc/ui5_ui5/static/")) {
			res.writeHead(200, { "content-type": "text/plain" });
			return res.end("static");
		}
		if (!req.headers.authorization) {
			res.writeHead(401, { "set-cookie": ["sap-usercontext=sap-client=100; path=/", "sap-ssolist=SSO1; path=/", "other=x"] });
			return res.end();
		}
		// the backend's own pages set cookies for the backend's host, SameSite=None without Secure
		const cookies = String(req.url).includes("/sap/bc/ui2/flp")
			? { "set-cookie": ["sap-XSRF_SYS_100=tok; path=/; HttpOnly; SameSite=None", "MYSAPSSO2=t; path=/; domain=.backend.internal; HttpOnly; SameSite=None", "kept=1; path=/; SameSite=None; Secure"] }
			: {};
		res.writeHead(200, { "content-type": "application/json", ...cookies });
		res.end(JSON.stringify({ url: req.url, headers: req.headers }));
	});
	const services = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			if (req.url === "/oauth/token") {
				const client = new URLSearchParams(body).get("client_id");
				res.writeHead(200, { "content-type": "application/json" });
				return res.end(JSON.stringify({ access_token: `${client}-token`, expires_in: 3600 }));
			}
			if (req.url === "/destination-configuration/v1/destinations/SYS") {
				assert.strictEqual(req.headers.authorization, "Bearer dest-client-token");
				res.writeHead(200, { "content-type": "application/json" });
				return res.end(JSON.stringify({
					destinationConfiguration: { Name: "SYS", URL: "http://backend.internal:8000", ProxyType: "OnPremise", Authentication: "BasicAuthentication", "sap-client": "100", CloudConnectorLocationId: "LOC1" },
					authTokens: [{ type: "Basic", value: "VEVDSDpwdw==", http_header: { key: "Authorization", value: "Basic VEVDSDpwdw==" } }]
				}));
			}
			res.writeHead(404);
			res.end();
		});
	});
	const upstreamPort = await listen(upstream);
	const servicesPort = await listen(services);
	const ports = { proxy: await freePort(), tunnel: await freePort(), tls: await freePort() };
	const w = world({ BTP_PROXY_PORT: ports.proxy, BTP_TUNNEL_PORT: ports.tunnel, BTP_PROXY_TLS_PORT: ports.tls, BTP_CF_USER: "me@example.org", BTP_CF_PASSWORD_ENV: "EP_CF_PASSWORD", ...envFile });
	w.env.EP_CF_PASSWORD = "good";
	const svc = `http://127.0.0.1:${servicesPort}`;
	fs.writeFileSync(path.join(w.cfDir, "app-env.json"), JSON.stringify({
		system_env_json: {
			VCAP_SERVICES: {
				destination: [{ credentials: { url: svc, uri: svc, clientid: "dest-client", clientsecret: "s" } }],
				connectivity: [{ credentials: { url: svc, clientid: "conn-client", clientsecret: "s", onpremise_proxy_host: "127.0.0.1", onpremise_proxy_http_port: upstreamPort } }]
			}
		}
	}));
	const close = () => {
		upstream.close();
		services.close();
	};
	return { ...w, ports, upstreamRequests, close };
}

function startProxy(w) {
	const child = spawn(process.execPath, [path.join("scripts", "btp-proxy.js"), "--profile", "dev"], { cwd: w.project, env: w.env, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	child.stdout.on("data", (c) => (out += c));
	child.stderr.on("data", (c) => (out += c));
	return { child, output: () => out };
}

async function proxy() {
	const tls = hasOpenssl();
	const w = await btpWorld();
	if (tls) {
		const dir = /** @type {string} */ (w.env.BTP_PROXY_TLS_DIR);
		fs.mkdirSync(dir, { recursive: true });
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost", "-keyout", path.join(dir, "localhost.key"), "-out", path.join(dir, "localhost.crt")], { stdio: "ignore", shell: isWin });
	}
	// as in a Business Application Studio dev space: with a tunnel app the cf route is still used (ADT needs cookies)
	w.env.H2O_URL = "http://127.0.0.1:9";
	const p = startProxy(w);
	try {
		await waitFor("the proxy", () => p.output().includes(tls ? "listening on https" : "listening on http"));
		const base = `http://127.0.0.1:${w.ports.proxy}`;
		// expired session at start: logged in with the environment's user, then targeted
		assert.ok(w.calls().includes("auth | user=me@example.org | pw=set"), "logged in on start");

		const health = JSON.parse((await request(`${base}/__btp-proxy/health`)).body);
		assert.strictEqual(health.destination, "SYS");
		assert.strictEqual(health.mode, "cf", "tunnel app set: cf route even in a dev space");
		assert.strictEqual(health.tlsPort, w.ports.tls);
		assert.ok(health.pid > 0);

		// first a URL the backend serves without a logon: priming gets no cookie, and that empty
		// answer must not be kept, or the next Basic logon would go out without the SSO list
		let r = await request(`${base}/sap/bc/ui5_ui5/static/app.js`);
		assert.strictEqual(r.status, 200, r.body);

		// an ADT call: absolute URL with sap-client, connectivity token, location id, destination logon, primed cookies
		r = await request(`${base}/sap/bc/adt/discovery`);
		assert.strictEqual(r.status, 200, r.body);
		const seen = JSON.parse(r.body);
		assert.strictEqual(seen.url, "http://backend.internal:8000/sap/bc/adt/discovery?sap-client=100");
		assert.strictEqual(seen.headers["proxy-authorization"], "Bearer conn-client-token");
		assert.strictEqual(seen.headers["sap-connectivity-scc-location_id"], "LOC1");
		assert.strictEqual(seen.headers.authorization, "Basic VEVDSDpwdw==");
		assert.strictEqual(seen.headers.host, "backend.internal:8000");
		assert.match(seen.headers.cookie, /sap-usercontext=sap-client=100/);
		assert.match(seen.headers.cookie, /sap-ssolist=SSO1/);
		assert.doesNotMatch(seen.headers.cookie, /other=x/);

		// a browser sends the cookies of a proxy for another client (same host, other port):
		// sap-ssolist / sap-usercontext are replaced by this proxy's own, the rest is kept
		r = await request(`${base}/sap/bc/ui2/flp`, { headers: { cookie: "sap-ssolist=OTHERCLIENT; MYSAPSSO2=OTHERTICKET; sap-usercontext=sap-client=300; keep=1" } });
		const crossed = JSON.parse(r.body).headers.cookie;
		assert.match(crossed, /sap-ssolist=SSO1/);
		assert.match(crossed, /sap-usercontext=sap-client=100/);
		assert.match(crossed, /keep=1/);
		assert.doesNotMatch(crossed, /OTHERCLIENT|OTHERTICKET|MYSAPSSO2|sap-client=300/);

		// a browser on the backend's own pages: cookies become localhost cookies it keeps
		r = await request(`${base}/sap/bc/ui2/flp`);
		assert.deepStrictEqual(r.headers["set-cookie"], [
			"sap-XSRF_SYS_100=tok; path=/; HttpOnly; SameSite=Lax",
			"MYSAPSSO2=t; path=/; HttpOnly; SameSite=Lax",
			"kept=1; path=/; SameSite=None; Secure"
		]);

		// ADT's cloud endpoints are answered by the proxy, the backend never sees them
		const before = w.upstreamRequests.length;
		r = await request(`${base}/sap/public/bc/icf/virtualhost`);
		assert.strictEqual(r.status, 200);
		assert.deepStrictEqual(JSON.parse(r.body), { relatedUrls: { API: base, UI: base } }, "virtualhost points ADT back at the proxy");
		assert.strictEqual((await request(`${base}/.well-known/sap-adt-info`)).status, 404, "no OAuth info, ADT keeps Basic");
		assert.strictEqual((await request(`${base}/sap/public/bc/icf/logoff?sap-client=100`)).status, 200);
		assert.strictEqual(w.upstreamRequests.length, before);

		if (tls) {
			r = await request(`https://127.0.0.1:${w.ports.tls}/sap/bc/adt/discovery`);
			assert.strictEqual(r.status, 200, "https listener");
			const tlsBase = `https://127.0.0.1:${w.ports.tls}`;
			r = await request(`${tlsBase}/sap/public/bc/icf/virtualhost`);
			assert.deepStrictEqual(JSON.parse(r.body).relatedUrls, { API: tlsBase, UI: tlsBase }, "virtualhost on https");
			// on https the cookie keeps SameSite=None and gets Secure
			r = await request(`https://127.0.0.1:${w.ports.tls}/sap/bc/ui2/flp`);
			assert.strictEqual(r.headers["set-cookie"][0], "sap-XSRF_SYS_100=tok; path=/; HttpOnly; SameSite=None; Secure");
		} else {
			console.log("  (openssl not found: https listener not tested)");
		}

		// the tunnel drops while the session expired: the proxy logs in again and reopens it, listeners stay up
		w.state({ authed: false });
		w.clearCalls();
		process.kill(Number(fs.readFileSync(path.join(w.cfDir, "ssh.pid"), "utf8")));
		await waitFor("the tunnel to reopen", () => p.output().includes("ssh tunnel ready again"));
		assert.ok(w.commands().includes("auth"), "logged in again before reopening");
		assert.ok(w.commands().some((c) => c.startsWith("ssh ")), "tunnel reopened");
		r = await request(`${base}/sap/bc/adt/discovery`);
		assert.strictEqual(r.status, 200, "works again after the drop");
		console.log("OK proxy scenarios (destination, headers, cookies, virtualhost, https, tunnel drop + new login)");
	} catch (e) {
		console.error(p.output());
		throw e;
	} finally {
		p.child.kill();
		try {
			process.kill(Number(fs.readFileSync(path.join(w.cfDir, "ssh.pid"), "utf8")));
		} catch (e) { /* gone */ }
		w.close();
	}
}

/* ------------------------------------------------------------------ mcp */

function runMcp(w, command, extraEnv = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [path.join("scripts", "btp-mcp.js"), "dev", "--", ...command], { cwd: w.project, env: { ...w.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		child.on("exit", (code) => resolve({ code, stdout, stderr }));
	});
}

async function mcp() {
	const tool = [process.execPath, "-e", "console.log('tool output'); process.exit(4)"];
	const w = await btpWorld();
	let started;
	try {
		// no proxy yet: started in the background (detached), then the tool runs with stdout untouched
		let r = await runMcp(w, tool, { BTP_MCP_WAIT: "40" });
		assert.match(r.stderr, /starting btp-proxy for SYS/);
		assert.match(r.stderr, /btp-proxy ready after/);
		assert.strictEqual(r.stdout.trim(), "tool output", "stdout belongs to the tool only");
		assert.strictEqual(r.code, 4, "exit code passed on");
		const health = JSON.parse((await request(`http://127.0.0.1:${w.ports.proxy}/__btp-proxy/health`)).body);
		started = health.pid;
		assert.strictEqual(health.destination, "SYS", "the proxy outlives the launcher");

		// a second launch reuses it
		r = await runMcp(w, tool);
		assert.match(r.stderr, /reusing btp-proxy on :\d+ \(SYS\)/);
		assert.doesNotMatch(r.stderr, /starting/);

		// something else on the port is left alone
		process.kill(started);
		started = undefined;
		await waitFor("the port to be free", async () => !(await request(`http://127.0.0.1:${w.ports.proxy}/`).catch(() => false)));
		const other = http.createServer((req, res) => res.end("not a proxy"));
		await new Promise((resolve) => other.listen(w.ports.proxy, "127.0.0.1", () => resolve(undefined)));
		r = await runMcp(w, tool);
		assert.match(r.stderr, /taken by something else/);
		other.close();
		console.log("OK btp-mcp.js scenarios (start in the background, reuse, foreign port)");
	} finally {
		if (started) process.kill(started);
		try {
			process.kill(Number(fs.readFileSync(path.join(w.cfDir, "ssh.pid"), "utf8")));
		} catch (e) { /* gone */ }
		w.close();
	}
}

/* ------------------------------------------------------------------ adt */

/** A fake JRE: bin/keytool runs the fake keytool, which finds the JRE through its own folder (<jre>/fake). */
function fakeJre(javaHome) {
	fs.mkdirSync(path.join(javaHome, "lib", "security"), { recursive: true });
	fs.writeFileSync(path.join(javaHome, "lib", "security", "cacerts"), "fake");
	fs.mkdirSync(path.join(javaHome, "bin"), { recursive: true });
	fs.mkdirSync(path.join(javaHome, "fake"), { recursive: true });
	fs.copyFileSync(path.join(__dirname, "fakes", "keytool.js"), path.join(javaHome, "fake", "keytool.js"));
	fs.writeFileSync(path.join(javaHome, "bin", "keytool"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(javaHome, "fake", "keytool.js")}" "$@"\n`, { mode: 0o755 });
	return javaHome;
}

function adtCert(home, ...args) {
	const r = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "btp-setup.js"), "adt-cert", ...args], {
		encoding: "utf8",
		env: { ...process.env, HOME: home, USERPROFILE: home, BTP_PROXY_TLS_DIR: path.join(home, ".config", "btp-proxy") }
	});
	assert.strictEqual(r.status, 0, r.stderr || r.stdout);
	return JSON.parse(r.stdout);
}

function adt() {
	const adtLib = require("../generators/app/lib/adt");
	// WSL: Windows paths for Eclipse's keytool.exe
	assert.strictEqual(adtLib.toWindows("/mnt/d/eclipse/plugins/x/jre"), "D:\\eclipse\\plugins\\x\\jre");
	const distro = process.env.WSL_DISTRO_NAME;
	process.env.WSL_DISTRO_NAME = "Ubuntu-22.04";
	assert.strictEqual(adtLib.toWindows("/home/me/.config/btp-proxy/localhost.crt"), "\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\.config\\btp-proxy\\localhost.crt");
	if (distro === undefined) delete process.env.WSL_DISTRO_NAME;
	else process.env.WSL_DISTRO_NAME = distro;
	const cmd = adtLib.eclipseCommands({ install: "/mnt/c/eclipse", jre: "/mnt/c/eclipse/plugins/justj/jre" }, "/home/me/c.crt");
	if (isWin || adtLib.isWsl()) {
		assert.strictEqual(cmd.shell, "powershell");
		assert.match(cmd.command, /keytool\.exe" -importcert -noprompt -alias btp-proxy-localhost/);
	}

	// eclipse.ini -vm: a javaw.exe, a bin folder or a Java home, absolute or relative to the install
	const install = isWin ? "C:\\eclipsebare" : "/opt/eclipsebare";
	const vm = (line) => adtLib.vmJavaHome(install, `-startup\nplugins/x.jar\n-vm\n${line}\n-vmargs\n-Xmx2g\n`);
	assert.strictEqual(adtLib.vmJavaHome(install, "-vmargs\n-Xmx2g\n"), undefined, "no -vm");
	if (adtLib.isWsl()) {
		assert.strictEqual(vm("C:/eclipse/plugins/justj/jre/bin/javaw.exe"), "/mnt/c/eclipse/plugins/justj/jre");
		assert.strictEqual(vm("D:\\jdk-21\\bin"), "/mnt/d/jdk-21");
	} else if (isWin) {
		assert.strictEqual(vm("C:/eclipse/plugins/justj/jre/bin/javaw.exe"), "C:/eclipse/plugins/justj/jre");
		assert.strictEqual(vm("D:\\jdk-21"), "D:\\jdk-21");
	} else {
		assert.strictEqual(vm("/usr/lib/jvm/java-21/bin/java"), "/usr/lib/jvm/java-21");
		assert.strictEqual(vm("/usr/lib/jvm/java-21/bin/"), "/usr/lib/jvm/java-21");
		assert.strictEqual(vm("jre/bin/java"), path.join(install, "jre"), "relative to the install");
	}

	if (isWin || !hasOpenssl()) {
		// the fake keytool is a shell script: the JRE import runs on Linux / macOS (and WSL)
		console.log(`OK adt-cert scenarios (WSL paths only${isWin ? " - JRE import is tested on Linux / macOS" : " - openssl not found"})`);
		return;
	}
	const home = tmp("btp-adt-home-");
	const ext = path.join(home, ".vscode-server", "extensions");
	const linuxJre = fakeJre(path.join(ext, "sapse.adt-vscode-1.2.0-linux-x64", "adt-ls", "linux", "gtk", "x86_64", "plugins", "com.sap.adt.jvm.x_21", "jre"));
	const macJre = fakeJre(path.join(home, ".vscode", "extensions", "sapse.adt-vscode-1.2.0-darwin-arm64", "adt-ls", "macosx", "cocoa", "aarch64", "plugins", "com.sap.adt.jvm.x_21", "jre", "Contents", "Home"));
	const eclipseJre = path.join(home, "eclipse", "plugins", "org.eclipse.justj.openjdk.hotspot.jre.full.linux.x86_64_21.0.11", "jre");
	fakeJre(eclipseJre);

	// first run: certificate created, both VS Code layouts imported, cacerts kept as .orig
	let r = adtCert(home);
	assert.strictEqual(r.created, true);
	const certDir = path.join(home, ".config", "btp-proxy");
	assert.ok(fs.existsSync(path.join(certDir, "localhost.crt")) && fs.existsSync(path.join(certDir, "localhost.key")));
	assert.strictEqual(fs.statSync(path.join(certDir, "localhost.key")).mode & 0o077, 0, "key readable by its owner only");
	assert.deepStrictEqual(r.vscode.map((v) => v.jre).sort(), [linuxJre, macJre].sort());
	assert.ok(r.vscode.every((v) => /^imported/.test(v.status)), JSON.stringify(r.vscode));
	assert.ok(fs.existsSync(path.join(linuxJre, "lib", "security", "cacerts.orig")));
	// the certificate is for localhost and 127.0.0.1
	const text = execFileSync("openssl", ["x509", "-in", path.join(certDir, "localhost.crt"), "-noout", "-text"], { encoding: "utf8" });
	assert.match(text, /DNS:localhost/);
	assert.match(text, /IP Address:127\.0\.0\.1/);

	// second run: nothing to do
	r = adtCert(home);
	assert.strictEqual(r.created, false);
	assert.ok(r.vscode.every((v) => v.status === "already trusted"), JSON.stringify(r.vscode));

	// --renew: a new certificate replaces the old entry
	const before = fs.readFileSync(path.join(linuxJre, "imported.sha256"), "utf8");
	r = adtCert(home, "--renew");
	assert.strictEqual(r.created, true);
	assert.notStrictEqual(fs.readFileSync(path.join(linuxJre, "imported.sha256"), "utf8"), before);
	assert.match(fs.readFileSync(path.join(linuxJre, "keytool.log"), "utf8"), /-delete -alias btp-proxy-localhost/);

	// Eclipse: found in ~/eclipse* on Linux / macOS (on WSL the Windows drives are searched instead). eclipsebare
	// runs on another Java through eclipse.ini -vm; eclipse-java shares that Java and gets no second import
	if (!adtLib.isWsl()) {
		const ownJava = fakeJre(path.join(home, "jdk-21"));
		for (const name of ["eclipsebare", "eclipse-java"]) {
			fs.mkdirSync(path.join(home, name, "plugins"), { recursive: true });
			fs.writeFileSync(path.join(home, name, "eclipse.ini"), `-startup\nplugins/x.jar\n-vm\n${ownJava}/bin/java\n-vmargs\n-Xmx2g\n`);
		}
		r = adtCert(home);
		const byJre = Object.fromEntries(r.eclipse.map((e) => [e.command.includes(ownJava) ? "own" : "bundled", e]));
		assert.deepStrictEqual(byJre.bundled.installs, [path.join(home, "eclipse")]);
		assert.strictEqual(byJre.bundled.source, "bundled");
		assert.deepStrictEqual(byJre.own.installs.sort(), [path.join(home, "eclipse-java"), path.join(home, "eclipsebare")]);
		assert.strictEqual(byJre.own.source, "eclipse.ini -vm");
		assert.strictEqual(r.eclipse.length, 2, "one import per Java");
		assert.ok(r.eclipse.every((e) => e.shell === "sh" && /keytool" -importcert -noprompt -alias btp-proxy-localhost/.test(e.command)));
	} else {
		assert.ok(r.eclipse.every((e) => e.shell === "powershell"));
	}
	console.log("OK adt-cert scenarios (certificate, VS Code ADT JREs Linux + macOS layouts, renew, Eclipse, WSL paths)");
}

/* ------------------------------------------------------------------ apps */

async function apps() {
	const w = world();
	w.state({ authed: true });
	const rel = (kind, guid) => ({ [kind]: { data: { guid } } });
	const binding = (app, instance) => ({ relationships: { ...rel("app", app), ...rel("service_instance", instance) } });
	fs.writeFileSync(path.join(w.cfDir, "v3.json"), JSON.stringify({
		"/v3/service_offerings": { resources: [{ guid: "of-d", name: "destination" }, { guid: "of-c", name: "connectivity" }] },
		"/v3/service_plans": { resources: [{ guid: "p-d", relationships: rel("service_offering", "of-d") }, { guid: "p-c", relationships: rel("service_offering", "of-c") }] },
		"/v3/service_instances": { resources: [{ guid: "i-d", name: "dest", relationships: rel("service_plan", "p-d") }, { guid: "i-c", name: "conn", relationships: rel("service_plan", "p-c") }] },
		// bindings to the destination / connectivity instances: the approuter has no connectivity
		"/v3/service_credential_bindings?type=app&service_instance_guids": {
			resources: [binding("a-srv", "i-d"), binding("a-srv", "i-c"), binding("a-cap", "i-d"), binding("a-cap", "i-c"), binding("a-tun", "i-d"), binding("a-tun", "i-c"), binding("a-ar", "i-d")],
			included: { apps: [{ guid: "a-srv", name: "web-srv" }, { guid: "a-cap", name: "cap-srv" }, { guid: "a-tun", name: "dev-tunnel" }, { guid: "a-ar", name: "approuter" }] }
		},
		// every binding of the candidates: cap-srv also has an xsuaa instance
		"/v3/service_credential_bindings?type=app&app_guids": {
			resources: [binding("a-srv", "i-d"), binding("a-srv", "i-c"), binding("a-cap", "i-d"), binding("a-cap", "i-c"), binding("a-cap", "i-xsuaa"), binding("a-tun", "i-d"), binding("a-tun", "i-c")]
		},
		// web-srv has a route
		"/v3/routes": { resources: [{ destinations: [{ app: { guid: "a-srv" } }] }] }
	}));
	const code = `require(${JSON.stringify(path.join(__dirname, "..", "generators", "app", "lib", "cf.js"))}).boundApps("s1").then((r) => console.log(JSON.stringify(r)))`;
	const r = spawnSync(process.execPath, ["-e", code], { env: w.env, encoding: "utf8" });
	assert.strictEqual(r.status, 0, r.stderr);
	assert.deepStrictEqual(JSON.parse(r.stdout), [
		{ guid: "a-cap", name: "cap-srv", tunnel: false },
		{ guid: "a-tun", name: "dev-tunnel", tunnel: true },
		{ guid: "a-srv", name: "web-srv", tunnel: false }
	]);
	console.log("OK apps scenario (approuter left out, routes or other services make a real application)");
}

/** Business Application Studio: requests go to the dev space's proxy as http://<destination>.dest, no cf. */
async function bas() {
	const seen = [];
	// the dev space's destination proxy: plain HTTP proxy semantics, it adds the destination's logon itself
	const devProxy = http.createServer((req, res) => {
		// like the dev space: H2O_URL is only reachable through this proxy
		if (String(req.url).endsWith("/api/listDestinations")) {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify([{ Name: "OTHER", ProxyType: "Internet" }, { Name: "SYS", ProxyType: "OnPremise", WebIDEEnabled: "true", "sap-client": "100" }]));
		}
		seen.push({ url: req.url, headers: req.headers });
		// the backend hands ADT's logon ticket to the callback ADT listens on, a local port of the dev space
		if (String(req.url).includes("/reentranceticket")) {
			res.writeHead(307, { location: "http://localhost:44125/adt/redirect?_=1&reentrance-ticket=T%3d" });
			return res.end();
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ url: req.url }));
	});
	const h2o = http.createServer((req, res) => {
		// straight to H2O_URL: "Not Found", as seen in a real dev space
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("Not Found");
	});
	const devPort = await listen(devProxy);
	const h2oPort = await listen(h2o);
	const ports = { proxy: await freePort() };
	// no BTP_APP, no cf login: none of it is used in a dev space
	const w = world({ BTP_APP: undefined, BTP_CF_API: undefined, BTP_PROXY_PORT: ports.proxy });
	w.env.H2O_URL = `http://127.0.0.1:${h2oPort}`;
	w.env.http_proxy = `http://127.0.0.1:${devPort}`;
	const p = startProxy(w);
	try {
		await waitFor("the proxy", () => p.output().includes("listening on http"));
		const base = `http://127.0.0.1:${ports.proxy}`;
		assert.deepStrictEqual(w.commands(), [], "cf never called");
		assert.strictEqual(JSON.parse((await request(`${base}/__btp-proxy/health`)).body).mode, "bas");

		let r = await request(`${base}/sap/bc/adt/discovery`, { headers: { authorization: "Basic dTpw" } });
		assert.strictEqual(r.status, 200);
		const last = seen[seen.length - 1];
		assert.strictEqual(last.url, "http://SYS.dest/sap/bc/adt/discovery?sap-client=100", "absolute .dest URL with the destination's client");
		assert.strictEqual(last.headers.host, "SYS.dest", "destination name case kept");
		assert.strictEqual(last.headers["proxy-authorization"], undefined, "no connectivity token, the dev space adds it");
		assert.strictEqual(last.headers["sap-connectivity-scc-location_id"], undefined);

		// the cloud endpoints ADT asks for are answered here, the dev space proxy never sees them
		const before = seen.length;
		r = await request(`${base}/sap/public/bc/icf/virtualhost`);
		assert.deepStrictEqual(JSON.parse(r.body), { relatedUrls: { API: base, UI: base } });
		assert.strictEqual((await request(`${base}/.well-known/sap-adt-info`)).status, 404);
		assert.strictEqual((await request(`${base}/sap/public/bc/icf/logoff`)).status, 200);
		assert.ok(seen.slice(before).every((s) => !/virtualhost|well-known|logoff/.test(s.url)), "cloud endpoints not forwarded");
		// ADT's browser logon from outside the dev space: the callback goes through the same port forwarding
		const ticketUrl = `${base}/sap/bc/adt/core/http/reentranceticket?redirect-url=x`;
		r = await request(ticketUrl, { headers: { "x-forwarded-host": "portssl5443-workspaces-ws-abc.eu01cf.applicationstudio.cloud.sap", "x-forwarded-proto": "https" } });
		assert.strictEqual(r.status, 307);
		assert.strictEqual(r.headers.location, "https://port44125-workspaces-ws-abc.eu01cf.applicationstudio.cloud.sap/adt/redirect?_=1&reentrance-ticket=T%3d");
		// a forwarded host that isn't a plain host name can't send the ticket elsewhere
		r = await request(ticketUrl, { headers: { "x-forwarded-host": "port1-x@evil.example", "x-forwarded-proto": "https" } });
		assert.strictEqual(r.headers.location, "http://localhost:44125/adt/redirect?_=1&reentrance-ticket=T%3d", "no rewrite to another host");
		// from inside the dev space (curl, ADT itself) the local callback stays as it is
		assert.strictEqual((await request(ticketUrl)).headers.location, "http://localhost:44125/adt/redirect?_=1&reentrance-ticket=T%3d");
		console.log("OK bas scenario (dev space proxy, .dest URL, sap-client from the destination list, no cf, logon callback through port forwarding)");
	} catch (e) {
		console.error(p.output());
		throw e;
	} finally {
		p.child.kill();
		devProxy.close();
		h2o.close();
	}
}

/* ------------------------------------------------------------------ */

(async () => {
	const all = { login, proxy, bas, mcp, adt, apps };
	for (const [name, run] of Object.entries(all)) {
		if (only.length && !only.includes(name)) continue;
		await run();
	}
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
