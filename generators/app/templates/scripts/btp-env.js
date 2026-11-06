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
// built on each call: loadProfile() may add variables (CF_HOME...) after this module is loaded
const cfOptions = (extraEnv = {}) => ({ env: { ...process.env, MSYS_NO_PATHCONV: "1", ...extraEnv } });
const cfWithEnv = (extraEnv, ...args) =>
	(isWin
		? execSync(["cf", ...args].map(quote).join(" "), { ...cfOptions(extraEnv), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
		: execFileSync("cf", args, { ...cfOptions(extraEnv), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim();
const cf = (...args) => cfWithEnv({}, ...args);
/**
 * spawn / spawnSync arguments for a cf command: spawn(...cfCommand(["ssh", app], { stdio: "inherit" })). On Windows
 * the arguments are already in the command line, and the second element is the options.
 * @param {string[]} args
 * @param {import("child_process").SpawnOptions} [options]
 * @returns {[string, any, any?]}
 */
const cfCommand = (args, options = {}) =>
	isWin
		? [["cf", ...args].map(quote).join(" "), { ...cfOptions(), ...options, shell: true }]
		: ["cf", args, { ...cfOptions(), ...options }];
const cfInteractive = (args) => spawnSync(...cfCommand(args, { stdio: "inherit" }));

const field = (text, key) => ((new RegExp(`^${key}:\\s*(.+)$`, "im").exec(text) || [])[1] || "").trim();
const sameApi = (a, b) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

// A rejected cf auth is remembered on disk, for this user and password, so that proxies started again and again
// (several MCP servers, every new session) never lock the account. A changed password is tried once more; a
// session that works again clears it. The marker holds a short fingerprint, never the password.
const crypto = require("crypto");
const os = require("os");
const REJECTED_DIR = path.join(os.homedir(), ".cache", "btp-on-premise");
const fingerprint = (user, password) => crypto.createHash("sha256").update(`${user}\0${password}`).digest("hex").slice(0, 8);
const rejectedFile = (user) => path.join(REJECTED_DIR, `auth-rejected-${user.replace(/[^\w.@-]/g, "_")}`);
function rejectedBefore({ user, password }) {
	try {
		const [fp, ...reason] = fs.readFileSync(rejectedFile(user), "utf8").split("\n");
		return fp === fingerprint(user, password) ? reason.join(" ").trim() || "rejected" : undefined;
	} catch (e) {
		return undefined;
	}
}
function rememberRejected({ user, password }, reason) {
	try {
		fs.mkdirSync(REJECTED_DIR, { recursive: true });
		fs.writeFileSync(rejectedFile(user), `${fingerprint(user, password)}\n${reason}\n`, { mode: 0o600 });
	} catch (e) { /* best effort */ }
}
function forgetRejected(user) {
	if (user) fs.rmSync(rejectedFile(user), { force: true });
}
const lastLine = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^FAILED$/i.test(l)).pop() || text.trim();

/**
 * Who the scripts log in as without a terminal: BTP_CF_USER (from .env.<env>, else CF_USERNAME) and the password in
 * the variable named by BTP_CF_PASSWORD_ENV (default CF_PASSWORD), set in the shell profile, never in a project file.
 */
function credentials() {
	const user = (process.env.BTP_CF_USER || process.env.CF_USERNAME || "").trim();
	const passwordVar = (process.env.BTP_CF_PASSWORD_ENV || "CF_PASSWORD").trim();
	return { user, passwordVar, password: process.env[passwordVar] || "" };
}

/**
 * Non-interactive login. cf auth reads CF_USERNAME / CF_PASSWORD from its environment (set for this one call), so
 * the password never shows up in a process list. BTP_CF_ORIGIN names a custom identity provider (cf auth --origin).
 */
function loginFromEnv({ user, password }, endpoint, org, space) {
	if (endpoint) cf("api", endpoint);
	const origin = (process.env.BTP_CF_ORIGIN || "").trim();
	try {
		cfWithEnv({ CF_USERNAME: user, CF_PASSWORD: password }, "auth", ...(origin ? ["--origin", origin] : []));
	} catch (e) {
		// cf prints "Credentials were rejected" without echoing the password
		const reason = lastLine((e.stderr || e.stdout || e.message).toString());
		// only a refused logon counts against the account; a network error may be retried
		throw Object.assign(new Error(`cf auth as ${user} failed: ${reason}`), { rejected: /credentials|password|rejected|unauthorized|locked/i.test(reason), reason });
	}
	forgetRejected(user);
	try {
		cf("target", "-o", org, "-s", space);
	} catch (e) {
		// logged in fine: another cf login would not help, the org / space or the user's role is wrong
		throw Object.assign(new Error(`logged in as ${user}, but cf target -o "${org}" -s "${space}" failed: ${(e.stderr || e.stdout || e.message).toString().trim()}`), { loggedIn: true });
	}
}

/**
 * Points the cf CLI at BTP_CF_API / BTP_CF_ORG / BTP_CF_SPACE (cf app / cf ssh work on the targeted space).
 * Another org or space is targeted directly. Another API endpoint (region) or an expired session needs a login:
 * with a user and its password variable set (see credentials) it runs cf auth on its own, otherwise cf login
 * starts in the terminal when `interactive` is set.
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
			// cf target keeps answering after the token has expired - oauth-token needs a valid (or refreshable) one
			cf("oauth-token");
		} catch (e) {
			target = undefined; /* not logged in, or the session expired */
		}
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
	const why = api && current && !sameApi(current, api) ? `cf points at ${current}, this environment lives on ${api}` : "not logged in to Cloud Foundry (or the session expired)";
	let envError;
	// an environment set up for single sign-on may live in another subaccount or identity provider than the
	// global CF_USERNAME: never switch the cf session to that user (or count failed logons against it)
	const sso = process.env.BTP_CF_SSO === "true";
	const creds = credentials();
	const rejected = creds.user && creds.password && !sso ? rejectedBefore(creds) : undefined;
	if (rejected) {
		envError = `cf auth as ${creds.user} was rejected before with this password (${rejected}), not trying again so the account does not get locked - update ${creds.passwordVar}`;
	} else if (creds.user && creds.password && !sso) {
		log(`${why} - logging in as ${creds.user} (password from ${creds.passwordVar})`);
		try {
			return loginFromEnv(creds, endpoint, org, space);
		} catch (e) {
			if (e.loggedIn) throw e;
			// proxies are started again and again (tunnel drops, MCP servers, new sessions): never risk locking the account
			if (e.rejected) rememberRejected(creds, e.reason);
			envError = e.message;
		}
	}
	const loginArgs = ["login", ...(endpoint ? ["-a", endpoint] : []), "-o", org, "-s", space, ...(sso ? ["--sso"] : [])];
	const command = ["cf", ...loginArgs].map(quote).join(" ");
	const missing = creds.user ? creds.passwordVar : `CF_USERNAME and ${creds.passwordVar}`;
	const hint = envError ? `${envError} - check ${creds.passwordVar}, or run: ${command}` : sso ? `${why} - run: ${command}` : `${why} - set ${missing}, or run: ${command}`;
	if (!interactive || !process.stdin.isTTY) throw new Error(hint);
	if (envError) log(envError);
	log(`${why} - logging in: ${command}`);
	const result = cfInteractive(loginArgs);
	if (result.status !== 0) throw new Error(`cf login failed - run: ${command}`);
}

module.exports = { ROOT, loadProfile, profiles, ensureCfTarget, credentials, cf, cfCommand };
