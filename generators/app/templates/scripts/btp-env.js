/*
 * Shared by btp.js and btp-proxy.js: loads the settings of an environment and points cf at it.
 *
 * Each environment (dev, qual, ...) has its own .env.<name>, written by @scodigis/generator-btp-on-premise-scripts.
 * A plain .env is loaded after it for shared values (it never overrides the environment file).
 */
const fs = require("fs");
const path = require("path");
const { execFileSync, execSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const isWin = process.platform === "win32";

if (Number(process.versions.node.split(".")[0]) < 22) {
	console.error(`[btp] Node.js 22 or later is required, this is ${process.version}`);
	process.exit(1);
}

// .env values never override variables already set in the environment
function loadEnvFile(file) {
	if (!fs.existsSync(file)) return;
	if (process.loadEnvFile) return process.loadEnvFile(file);
	for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
		const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line);
		if (!m || m[1] in process.env) continue;
		let value = m[2].trim();
		if (/^(["'`]).*\1$/.test(value)) value = value.slice(1, -1);
		else value = value.replace(/\s+#.*$/, "");
		process.env[m[1]] = value;
	}
}

/** Names of the environments set up in the project (.env.<name> files with BTP_APP). */
function profiles() {
	return fs.readdirSync(ROOT)
		.filter((f) => /^\.env\.[\w-]+$/.test(f) && /^\s*BTP_APP\s*=/m.test(fs.readFileSync(path.join(ROOT, f), "utf8")))
		.map((f) => f.slice(".env.".length));
}

/**
 * Loads .env.<profile> (+ .env) and returns the profile name. Without a name, the only environment of the
 * project is used; a project set up before environments existed keeps working from .env alone.
 */
function loadProfile(profile) {
	if (!profile) {
		const all = profiles();
		if (all.length > 1) throw new Error(`several environments are set up (${all.join(", ")}) - name one, e.g. npm run start-btp:${all[0]}`);
		profile = all[0];
	}
	if (profile) {
		const file = path.join(ROOT, `.env.${profile}`);
		if (!fs.existsSync(file)) throw new Error(`no environment '${profile}' (.env.${profile} not found) - run the 'BTP On-Premise Access' generator for it`);
		loadEnvFile(file);
	}
	loadEnvFile(path.join(ROOT, ".env"));
	return profile;
}

// on Windows cf is often a .cmd / .bat shim and needs a shell - the command line is quoted here (org / space names may hold spaces)
const quote = (arg) => (/^[\w\-.\/\\:=@]+$/.test(arg) ? arg : `"${String(arg).replace(/"/g, '""')}"`);
const cfOptions = { env: { ...process.env, MSYS_NO_PATHCONV: "1" } };
const cf = (...args) =>
	(isWin
		? execSync(["cf", ...args].map(quote).join(" "), { ...cfOptions, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
		: execFileSync("cf", args, { ...cfOptions, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim();
/** spawn / spawnSync arguments for a cf command: spawn(...cfCommand(["ssh", app], { stdio: "inherit" })) */
const cfCommand = (args, options = {}) =>
	isWin
		? [["cf", ...args].map(quote).join(" "), { ...cfOptions, ...options, shell: true }]
		: ["cf", args, { ...cfOptions, ...options }];
const cfInteractive = (args) => spawnSync(...cfCommand(args, { stdio: "inherit" }));

const field = (text, key) => ((new RegExp(`^${key}:\\s*(.+)$`, "im").exec(text) || [])[1] || "").trim();
const sameApi = (a, b) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

/**
 * Points the cf CLI at BTP_CF_API / BTP_CF_ORG / BTP_CF_SPACE (cf app / cf ssh work on the targeted space).
 * Another org or space is targeted directly; another API endpoint (region) or an expired session needs a
 * cf login, which is started in the terminal when `interactive` is set.
 */
function ensureCfTarget({ interactive = false, log = console.log } = {}) {
	const { BTP_CF_API: api, BTP_CF_ORG: org, BTP_CF_SPACE: space } = process.env;
	if (!org || !space) return;
	let current = "";
	try {
		current = field(cf("api"), "API endpoint");
	} catch (e) { /* no endpoint yet */ }
	let target;
	if (!api || (current && sameApi(current, api))) {
		try {
			target = cf("target");
		} catch (e) { /* not logged in */ }
	}
	if (target) {
		if (field(target, "org") === org && field(target, "space") === space) return;
		log(`switching cf target from ${field(target, "org") || "-"}/${field(target, "space") || "-"} to ${org}/${space}`);
		try {
			cf("target", "-o", org, "-s", space);
			return;
		} catch (e) {
			throw new Error(`cf target -o "${org}" -s "${space}" failed: ${(e.stderr || e.stdout || e.message).toString().trim()}`);
		}
	}
	const endpoint = api || current;
	const loginArgs = ["login", ...(endpoint ? ["-a", endpoint] : []), "-o", org, "-s", space, ...(process.env.BTP_CF_SSO === "true" ? ["--sso"] : [])];
	const command = ["cf", ...loginArgs].map(quote).join(" ");
	const why = api && current && !sameApi(current, api) ? `cf points at ${current}, this environment lives on ${api}` : "not logged in to Cloud Foundry (or the session expired)";
	if (!interactive || !process.stdin.isTTY) throw new Error(`${why} - run: ${command}`);
	log(`${why} - logging in: ${command}`);
	const result = cfInteractive(loginArgs);
	if (result.status !== 0) throw new Error(`cf login failed - run: ${command}`);
}

module.exports = { ROOT, loadProfile, profiles, ensureCfTarget, cf, cfCommand };
