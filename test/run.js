"use strict";
/*
 * Runs the generator against a copy of a project with the cf helpers stubbed.
 *   node test/run.js [project folder] [--verbose]
 * Default project: test/fixture/app. --verbose prints the generated / changed files of each scenario.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const fixture = path.join(__dirname, "fixture", "app");
const source = path.resolve(args.find((a) => !a.startsWith("--")) || fixture);
const isFixture = source === fixture;

// the environment may load the generator through its own module instance - hand out the stub to every require of lib/cf
const Module = require("module");
const cf = { ...require("../generators/app/lib/cf") };
const originalRequire = Module.prototype.require;
Module.prototype.require = function (request) {
	return /[\\/]lib[\\/]cf(\.js)?$/.test(request) || request === "./lib/cf" ? cf : originalRequire.apply(this, arguments);
};
const DESTINATIONS = [
	{ Name: "SYS_DEPLOY", Type: "HTTP", ProxyType: "OnPremise", URL: "http://sys:443", Authentication: "NoAuthentication", "sap-client": "100", level: "subaccount" },
	{ Name: "SYS_RUNTIME", Type: "HTTP", ProxyType: "OnPremise", URL: "http://sys:443", Authentication: "BasicAuthentication", User: "TECH", "sap-client": "300", level: "subaccount" },
	{ Name: "MYSYS", Type: "HTTP", ProxyType: "OnPremise", URL: "http://mysys:443", Authentication: "BasicAuthentication", User: "TECH", level: "subaccount" },
	{ Name: "INTERNET", Type: "HTTP", ProxyType: "Internet", URL: "https://example.org", Authentication: "NoAuthentication", level: "subaccount" }
];
// set loggedOut to start a scenario without a cf session; loginWithPasscode records its arguments
const session = { loggedOut: false, logins: [], api: undefined };
// apps bound in the space; createTunnelApp records its arguments and "creates" btp-tunnel
const space = { apps: [{ name: "my-srv", guid: "a1" }], created: [] };
Object.assign(cf, {
	loginStatus: async () =>
		session.loggedOut
			? { loggedIn: false, api: session.api || "https://api.cf.eu10.hana.ondemand.com", error: "token expired" }
			: { loggedIn: true, api: session.api || "https://api.cf.eu10.hana.ondemand.com", org: "my-org", space: "dev", user: "tester" },
	loginUrl: async (api) => api.replace("://api.", "://login."),
	loginWithPasscode: async (api, passcode) => {
		session.logins.push([api, passcode]);
		session.loggedOut = false;
		session.api = api;
	},
	orgs: async () => [{ name: "my-org", guid: "o1" }],
	spaces: async () => [{ name: "dev", guid: "s1" }, { name: "qual", guid: "s2" }],
	boundApps: async () => space.apps,
	createTunnelApp: async (org, spaceName, spaceGuid) => {
		space.created.push([org, spaceName, spaceGuid]);
		space.apps = [{ name: cf.TUNNEL.app, guid: "t1" }];
		return cf.TUNNEL.app;
	},
	sshEnabled: async () => ({ enabled: true }),
	destinations: async () => DESTINATIONS,
	target: async () => {}
});

const helpers = require("yeoman-test");
const { parseEnv } = require("../generators/app/lib/project");

function copyProject() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "btp-gen-"));
	const target = path.join(dir, path.basename(source));
	fs.cpSync(source, target, { recursive: true, filter: (src) => !/[\\/](node_modules|dist|\.git)$/.test(src) });
	// the copy starts without the generated files
	for (const f of fs.readdirSync(target)) {
		if (/^(ui5-btp|ui5-deploy-btp)(-[\w-]+)?\.yaml$|^\.env\.[\w-]+$/.test(f)) fs.rmSync(path.join(target, f), { force: true });
	}
	for (const f of ["btp.js", "btp-proxy.js", "btp-env.js"]) fs.rmSync(path.join(target, "scripts", f), { force: true });
	return target;
}

// options.project: run again on the project of an earlier scenario; options.setup(project): prepare the copy
async function scenario(title, prompts, verify, options = {}) {
	const project = options.project || copyProject();
	if (options.setup) options.setup(project);
	const profile = prompts.profile || "dev";
	await helpers
		.run(path.join(__dirname, "..", "generators", "app"))
		.cd(project)
		.withOptions({ skipInstall: true })
		.withPrompts({ projectPath: project, profile, org: "my-org", space: "dev", app: "my-srv", ...prompts });
	const read = (f) => fs.readFileSync(path.join(project, f), "utf8");
	if (verbose) {
		console.log(`\n================ ${title} (${project})`);
		for (const f of [`ui5-btp-${profile}.yaml`, `ui5-deploy-btp-${profile}.yaml`]) if (fs.existsSync(path.join(project, f))) console.log(`---- ${f}\n${read(f)}`);
		console.log(`---- .env.${profile} (values of USR / SAP_PWD hidden)\n${read(`.env.${profile}`).replace(/^(USR|SAP_PWD)=.*$/gm, "$1=***")}`);
		console.log(`---- package.json scripts\n${JSON.stringify(JSON.parse(read("package.json")).scripts, null, 2)}`);
	}
	verify(read, parseEnv(read(`.env.${profile}`)), project);
	console.log(`OK ${title}`);
	return project;
}

function launchJsonMerge() {
	const { launchJson } = require("../generators/app/lib/project");
	const existing = `{
	// generated by Fiori tools
	"version": "0.2.0",
	"configurations": [
		{ "name": "Start blick", "type": "node", "request": "launch", "args": ["fiori", "run", "--open", "test/flp.html"], },
	]
}`;
	const merged = JSON.parse(launchJson(existing, "dev").text);
	assert.deepStrictEqual(merged.configurations.map((c) => c.name), ["Run with BTP destination (dev)", "Start blick"]);
	assert.strictEqual(merged.configurations[0].command, "npm run start-btp:dev");
	assert.strictEqual(launchJson(launchJson(existing, "dev").text, "dev"), undefined, "not added twice");
	const two = JSON.parse(launchJson(launchJson(existing, "dev").text, "qual").text);
	assert.deepStrictEqual(two.configurations.map((c) => c.name), ["Run with BTP destination (qual)", "Run with BTP destination (dev)", "Start blick"]);
	assert.strictEqual(JSON.parse(launchJson("", "dev").text).configurations.length, 1, "empty file");
	assert.ok(launchJson("{ not json", "dev").error, "unreadable file is reported, not overwritten");
	const legacy = JSON.stringify({ configurations: [{ name: "Run with BTP destination (cf ssh)", command: "npm run start-btp" }] });
	assert.deepStrictEqual(JSON.parse(launchJson(legacy, "dev", { dropLegacy: true }).text).configurations.map((c) => c.command), ["npm run start-btp:dev"]);
	console.log("OK launch.json merge");
}

function existingConfiguration() {
	const { deployDefaults, runtimeDestinations } = require("../generators/app/lib/project");
	assert.deepStrictEqual(deployDefaults(fixture), { source: "ui5-deploy.yaml", app: "ZFIXTURE", package: "ZFIXTURE", transport: "SYSK900001", client: "100", destination: "MYSYS" });
	assert.deepStrictEqual(runtimeDestinations(fixture), ["MYSYS"]);
	assert.deepStrictEqual(deployDefaults(os.tmpdir()), {});
	console.log("OK existing ui5.yaml / ui5-deploy.yaml read");
}

async function regionList() {
	const regions = require("../generators/app/lib/regions");
	const page = `| other | table |
<table>
<tr><th valign="top">IaaS Provider</th><th>Region</th><th>Region Name</th><th>API Endpoint</th></tr>
<tr><td>

Amazon Web Services

</td><td>eu10</td><td>Europe \\(Frankfurt\\)</td><td>

**cf-eu10:**

api.cf.eu10.hana.ondemand.com

**cf-eu10-002:**

api.cf.eu10-002.hana.ondemand.com

</td></tr>
<tr><td>Microsoft Azure</td><td>cn20</td><td>China \\(North 3\\)</td><td>api.cf.cn20.platform.sapcloud.cn</td></tr>
</table>
<table>
<tr><th>IaaS Provider</th><th>Region Name</th><th>API Endpoint</th></tr>
<tr><td>Amazon Web Services</td><td>US East \\(VA\\)</td><td>api.cf.eu10.hana.ondemand.com</td></tr>
</table>`;
	assert.deepStrictEqual(regions.parse(page), [
		{ key: "eu10", api: "https://api.cf.eu10.hana.ondemand.com", location: "Europe (Frankfurt)", provider: "AWS" },
		{ key: "eu10-002", api: "https://api.cf.eu10-002.hana.ondemand.com", location: "Europe (Frankfurt)", provider: "AWS" },
		{ key: "cn20", api: "https://api.cf.cn20.platform.sapcloud.cn", location: "China (North 3)", provider: "Azure" }
	]);
	const realFetch = global.fetch;
	global.fetch = async () => {
		throw new Error("offline");
	};
	try {
		const offline = await regions.list();
		assert.strictEqual(offline.source, "built-in");
		assert.ok(offline.regions.some((r) => r.api === "https://api.cf.eu10-004.hana.ondemand.com"));
	} finally {
		global.fetch = realFetch;
	}
	console.log("OK region list");
}

(async () => {
	launchJsonMerge();
	await regionList();
	existingConfiguration();
	const project = await scenario(
		"different destinations, deploy without authentication",
		{ runtimeDestination: "SYS_RUNTIME", deployDestination: "SYS_DEPLOY", abapApp: "zfixture", abapPackage: "zfixture", abapTransport: "SYSK900001", abapClient: "100", deployUser: "DEPLOYER", deployPassword: "p#ss 'x'" },
		(read, env) => {
			assert.strictEqual(env.BTP_CF_API, "https://api.cf.eu10.hana.ondemand.com");
			assert.strictEqual(env.BTP_CF_ORG, "my-org");
			assert.strictEqual(env.BTP_DESTINATION, "SYS_RUNTIME");
			assert.strictEqual(env.BTP_APP, "my-srv"); // the only bound app, picked without a question
			assert.strictEqual(env.BTP_DEPLOY_DESTINATION, "SYS_DEPLOY");
			assert.strictEqual(env.BTP_PROXY_PORT, "5050");
			assert.strictEqual(env.BTP_DEPLOY_PROXY_PORT, "5051");
			assert.strictEqual(env.USR, "DEPLOYER");
			assert.strictEqual(env.SAP_PWD, "p#ss 'x'");
			assert.match(read("ui5-deploy-btp-dev.yaml"), /url: http:\/\/localhost:5051 # scripts\/btp-proxy.js -> BTP destination SYS_DEPLOY \(npm run deploy-btp:dev\)/);
			assert.match(read("ui5-deploy-btp-dev.yaml"), /username: env:USR/);
			assert.match(read("ui5-deploy-btp-dev.yaml"), /name: ZFIXTURE\n\s+package: ZFIXTURE/);
			assert.doesNotMatch(read("ui5-deploy-btp-dev.yaml"), /destination:/);
			assert.match(read("ui5-btp-dev.yaml"), /url: http:\/\/localhost:5050/);
			assert.match(read("scripts/btp.js"), /BTP_DEPLOY_DESTINATION/);
			assert.match(read("scripts/btp-env.js"), /ensureCfTarget/);
			assert.match(read(".gitignore"), /^\.env$/m);
			assert.match(read(".gitignore"), /^\.env\.dev$/m);
			const scripts = JSON.parse(read("package.json")).scripts;
			assert.strictEqual(scripts["start-btp:dev"], "node scripts/btp.js start dev");
			assert.strictEqual(scripts["deploy-btp:dev"], "node scripts/btp.js deploy dev");
			assert.strictEqual(scripts["deploy-btp-test:dev"], "node scripts/btp.js deploy dev --test");
			assert.strictEqual(scripts["btp-proxy:dev"], "node scripts/btp-proxy.js --profile dev");
			assert.strictEqual(JSON.parse(read(".vscode/launch.json")).configurations[0].command, "npm run start-btp:dev");
			if (isFixture) {
				assert.doesNotMatch(read("ui5-btp-dev.yaml"), /destination:|client:/);
				assert.match(read("ui5-btp-dev.yaml"), /ignoreCertErrors: false # If set to true/); // comments kept
				assert.strictEqual(parseEnv(read(".env")).OTHER, "keep-me"); // the shared .env is left alone
				assert.strictEqual(parseEnv(read(".env")).USR, "OLDUSER");
			}
		}
	);
	await scenario(
		"second environment in the same project",
		{ profile: "qual", space: "qual", runtimeDestination: "SYS_RUNTIME", deployDestination: "SYS_DEPLOY", abapApp: "ZFIXTURE", abapPackage: "ZFIXTURE", abapTransport: "SYSK900002", abapClient: "100", deployUser: "QUSER", deployPassword: "q" },
		(read, env) => {
			assert.strictEqual(env.BTP_CF_SPACE, "qual");
			// own ports, so dev and qual run side by side
			assert.deepStrictEqual([env.BTP_PROXY_PORT, env.BTP_TUNNEL_PORT, env.BTP_DEPLOY_PROXY_PORT, env.BTP_DEPLOY_TUNNEL_PORT], ["5052", "20005", "5053", "20006"]);
			assert.strictEqual(env.USR, "QUSER");
			assert.strictEqual(parseEnv(read(".env.dev")).USR, "DEPLOYER"); // dev untouched
			assert.match(read("ui5-btp-qual.yaml"), /url: http:\/\/localhost:5052/);
			assert.match(read("ui5-btp-dev.yaml"), /url: http:\/\/localhost:5050/);
			const scripts = JSON.parse(read("package.json")).scripts;
			assert.ok(scripts["start-btp:dev"] && scripts["start-btp:qual"]);
			assert.deepStrictEqual(JSON.parse(read(".vscode/launch.json")).configurations.slice(0, 2).map((c) => c.command), ["npm run start-btp:qual", "npm run start-btp:dev"]);
		},
		{ project }
	);
	await scenario(
		"existing environment run again keeps its ports",
		{ runtimeDestination: "SYS_RUNTIME", setupDeploy: false },
		(read, env) => {
			assert.strictEqual(env.BTP_PROXY_PORT, "5050");
			assert.strictEqual(env.BTP_DEPLOY_DESTINATION, undefined);
			assert.throws(() => read("ui5-deploy-btp-dev.yaml"), /ENOENT/);
			assert.match(read("ui5-deploy-btp-qual.yaml"), /localhost:5053/);
		},
		{ project }
	);
	await scenario(
		"same destination with basic authentication",
		{ runtimeDestination: "SYS_RUNTIME", deployDestination: "SYS_RUNTIME", abapApp: "ZFIXTURE", abapPackage: "$TMP", abapTransport: "", abapClient: "300" },
		(read, env) => {
			assert.strictEqual(env.BTP_DEPLOY_PROXY_PORT, undefined);
			assert.match(read("ui5-deploy-btp-dev.yaml"), /url: http:\/\/localhost:5050/);
			assert.doesNotMatch(read("ui5-deploy-btp-dev.yaml"), /credentials:/);
			assert.doesNotMatch(read("ui5-deploy-btp-dev.yaml"), /transport:/);
		}
	);
	await scenario(
		"runtime only, no deployment",
		{ runtimeDestination: "SYS_RUNTIME", setupDeploy: false, deployDestination: "SYS_DEPLOY", abapApp: "ZFIXTURE" },
		(read, env) => {
			assert.strictEqual(env.BTP_DESTINATION, "SYS_RUNTIME");
			assert.strictEqual(env.BTP_DEPLOY_DESTINATION, undefined);
			assert.strictEqual(env.BTP_DEPLOY_PROXY_PORT, undefined);
			assert.throws(() => read("ui5-deploy-btp-dev.yaml"), /ENOENT/);
			const scripts = JSON.parse(read("package.json")).scripts;
			assert.strictEqual(scripts["start-btp:dev"], "node scripts/btp.js start dev");
			assert.strictEqual(scripts["deploy-btp:dev"], undefined);
			assert.strictEqual(scripts["deploy-btp-test:dev"], undefined);
		}
	);
	await scenario(
		"project set up before environments existed is migrated",
		{ runtimeDestination: "SYS_RUNTIME", deployDestination: "SYS_RUNTIME", abapApp: "ZFIXTURE", abapPackage: "$TMP", abapTransport: "", abapClient: "300" },
		(read, env, dir) => {
			assert.strictEqual(env.BTP_APP, "my-srv");
			assert.strictEqual(env.BTP_PROXY_PORT, "5060"); // the old ports are kept
			const shared = parseEnv(read(".env"));
			assert.strictEqual(shared.BTP_APP, undefined);
			assert.strictEqual(shared.BTP_PROXY_PORT, undefined);
			assert.strictEqual(shared.OTHER, "keep-me");
			assert.ok(!fs.existsSync(path.join(dir, "ui5-btp.yaml")) && !fs.existsSync(path.join(dir, "ui5-deploy-btp.yaml")));
			const scripts = JSON.parse(read("package.json")).scripts;
			assert.strictEqual(scripts["start-btp"], undefined);
			assert.strictEqual(scripts["deploy-btp"], undefined);
			assert.strictEqual(scripts["start-btp:dev"], "node scripts/btp.js start dev");
			assert.deepStrictEqual(JSON.parse(read(".vscode/launch.json")).configurations.map((c) => c.command), ["npm run start-btp:dev"]);
		},
		{
			setup: (dir) => {
				fs.appendFileSync(path.join(dir, ".env"), "BTP_APP=my-srv\nBTP_CF_ORG=my-org\nBTP_CF_SPACE=dev\nBTP_DESTINATION=SYS_RUNTIME\nBTP_PROXY_PORT=5060\nBTP_TUNNEL_PORT=20060\n");
				fs.writeFileSync(path.join(dir, "ui5-btp.yaml"), fs.readFileSync(path.join(dir, "ui5.yaml")));
				fs.writeFileSync(path.join(dir, "ui5-deploy-btp.yaml"), fs.readFileSync(path.join(dir, "ui5.yaml")));
				const pkgFile = path.join(dir, "package.json");
				const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
				pkg.scripts = { ...pkg.scripts, "start-btp": "node scripts/btp.js start", "deploy-btp": "node scripts/btp.js deploy" };
				fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
				fs.mkdirSync(path.join(dir, ".vscode"), { recursive: true });
				fs.writeFileSync(path.join(dir, ".vscode", "launch.json"), JSON.stringify({ configurations: [{ name: "Run with BTP destination (cf ssh)", command: "npm run start-btp" }] }));
			}
		}
	);
	await scenario(
		"logged in, another region chosen for the environment",
		{ profile: "prod", cfSession: "login", cfRegion: "https://api.cf.eu20.hana.ondemand.com", cfLoginMethod: "sso", cfPasscode: "p1", runtimeDestination: "SYS_RUNTIME", setupDeploy: false },
		(read, env) => {
			assert.deepStrictEqual(session.logins.pop(), ["https://api.cf.eu20.hana.ondemand.com", "p1"]);
			assert.strictEqual(env.BTP_CF_API, "https://api.cf.eu20.hana.ondemand.com");
			assert.strictEqual(env.BTP_CF_SSO, "true");
		}
	);
	session.api = undefined;
	session.loggedOut = true;
	await scenario(
		"expired cf session, region and passcode",
		{ cfRegion: "https://api.cf.eu20.hana.ondemand.com", cfLoginMethod: "sso", cfPasscode: " abc123 ", runtimeDestination: "SYS_RUNTIME", deployDestination: "SYS_RUNTIME", abapApp: "ZFIXTURE", abapPackage: "$TMP", abapTransport: "", abapClient: "300" },
		(read, env) => {
			assert.deepStrictEqual(session.logins, [["https://api.cf.eu20.hana.ondemand.com", "abc123"]]);
			assert.strictEqual(env.BTP_DESTINATION, "SYS_RUNTIME");
		}
	);
	session.api = undefined;
	space.apps = [{ name: "other-srv", guid: "a0" }, { name: "my-srv", guid: "a1" }];
	await scenario(
		"several bound apps, one selected",
		{ app: "my-srv", runtimeDestination: "SYS_RUNTIME", deployDestination: "SYS_RUNTIME", abapApp: "ZFIXTURE", abapPackage: "$TMP", abapTransport: "", abapClient: "300" },
		(read, env) => assert.strictEqual(env.BTP_APP, "my-srv")
	);
	space.apps = [];
	await scenario(
		"no bound app, tunnel app created",
		{ createTunnel: true, runtimeDestination: "SYS_RUNTIME", deployDestination: "SYS_RUNTIME", abapApp: "ZFIXTURE", abapPackage: "$TMP", abapTransport: "", abapClient: "300" },
		(read, env) => {
			assert.deepStrictEqual(space.created, [["my-org", "dev", "s1"]]);
			assert.strictEqual(env.BTP_APP, "btp-tunnel");
		}
	);
	space.apps = [{ name: "my-srv", guid: "a1" }];
	if (isFixture) {
		await scenario(
			"defaults taken from the existing ui5.yaml / ui5-deploy.yaml",
			{},
			(read, env) => {
				assert.strictEqual(env.BTP_DESTINATION, "MYSYS");
				assert.strictEqual(env.BTP_DEPLOY_DESTINATION, "MYSYS");
				assert.match(read("ui5-deploy-btp-dev.yaml"), /name: ZFIXTURE\n\s+package: ZFIXTURE\n\s+transport: SYSK900001/);
				assert.match(read("ui5-deploy-btp-dev.yaml"), /client: "100"/);
			}
		);
	}
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
