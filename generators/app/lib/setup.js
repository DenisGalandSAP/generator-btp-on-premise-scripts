"use strict";
/*
 * The files of one environment, computed from the answers. Shared by the generator (writing step) and the
 * non-interactive CLI (bin/btp-setup.js) that the Claude Code plugin drives.
 */
const fs = require("fs");
const path = require("path");
const project = require("./project");

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]*$/i;
const BSP_NAME = /^(\/[A-Z0-9_]+\/)?[A-Z0-9_]+$/i;
const SUPPORTED_AUTH = ["NoAuthentication", "BasicAuthentication"];
const RUNTIME_PORTS = { proxy: 5050, tunnel: 20003 };
const DEPLOY_PORTS = { proxy: 5051, tunnel: 20004 };
const PORT_KEYS = ["BTP_PROXY_PORT", "BTP_TUNNEL_PORT", "BTP_DEPLOY_PROXY_PORT", "BTP_DEPLOY_TUNNEL_PORT"];
// keys a project set up before environments existed has in .env
const LEGACY_ENV_KEYS = ["BTP_APP", "BTP_CF_ORG", "BTP_CF_SPACE", "BTP_DESTINATION", "BTP_DEPLOY_DESTINATION", ...PORT_KEYS];
const ENV_HEADER = "SAP BTP on-premise access (@scodigis/generator-btp-on-premise-scripts)";
const SCRIPT_FILES = ["btp-env.js", "btp-proxy.js", "btp.js"];
const TEMPLATES = path.join(__dirname, "..", "templates", "scripts");

// settings of an environment - a project set up before environments existed has them in .env
function profileEnv(root, profile) {
	const own = project.read(path.join(root || "", `.env.${profile}`));
	if (own !== undefined) return { values: project.parseEnv(own), legacy: false };
	const legacy = project.parseEnv(project.read(path.join(root || "", ".env")));
	return legacy.BTP_APP ? { values: legacy, legacy: true } : { values: {}, legacy: false };
}

/** Reason a destination cannot be used by the local proxy, or undefined. */
function authProblem(d) {
	if (!d) return "Select a destination";
	if (!SUPPORTED_AUTH.includes(d.Authentication)) {
		return `'${d.Name}' uses ${d.Authentication}; the local proxy has no user token, only ${SUPPORTED_AUTH.join(" / ")} work`;
	}
	return undefined;
}

/**
 * Proxy / tunnel ports of an environment: its own ones when no other environment uses them, else the first
 * free set (5050 / 20003 + 5051 / 20004, then +2 each) - so several environments can run side by side.
 */
function ports(root, profile, prev = profileEnv(root, profile).values) {
	const used = new Set();
	for (const other of project.profiles(root).filter((p) => p !== profile)) {
		const env = project.parseEnv(project.read(path.join(root, `.env.${other}`)));
		for (const key of PORT_KEYS) if (env[key]) used.add(Number(env[key]));
	}
	const candidates = [];
	if (prev.BTP_PROXY_PORT) {
		const runtime = { proxy: Number(prev.BTP_PROXY_PORT), tunnel: Number(prev.BTP_TUNNEL_PORT || RUNTIME_PORTS.tunnel) };
		const deploy = prev.BTP_DEPLOY_PROXY_PORT
			? { proxy: Number(prev.BTP_DEPLOY_PROXY_PORT), tunnel: Number(prev.BTP_DEPLOY_TUNNEL_PORT || DEPLOY_PORTS.tunnel) }
			: { proxy: runtime.proxy + 1, tunnel: runtime.tunnel + 1 };
		candidates.push({ runtime, deploy });
	}
	for (let slot = 0; slot < 50; slot++) {
		candidates.push({
			runtime: { proxy: RUNTIME_PORTS.proxy + 2 * slot, tunnel: RUNTIME_PORTS.tunnel + 2 * slot },
			deploy: { proxy: DEPLOY_PORTS.proxy + 2 * slot, tunnel: DEPLOY_PORTS.tunnel + 2 * slot }
		});
	}
	return candidates.find((c) => ![c.runtime.proxy, c.runtime.tunnel, c.deploy.proxy, c.deploy.tunnel].some((p) => used.has(p)));
}

/**
 * Files to write for an environment.
 *   a: { profile, cfApi, sso (true / false / undefined = keep), org, space, app, runtimeDestination,
 *        deployDestination (undefined = no deployment), abapApp, abapPackage, abapTransport, abapClient,
 *        credentials (deploy destination without authentication), deployUser, deployPassword }
 * Returns { files: [[path relative to root, contents | null to remove]], scripts, warnings }.
 */
function plan(root, a) {
	const p = a.profile;
	const prev = profileEnv(root, p);
	const existing = prev.values;
	const setupDeploy = !!a.deployDestination;
	const scripts = { start: `start-btp:${p}`, deploy: `deploy-btp:${p}`, deployTest: `deploy-btp-test:${p}`, proxy: `btp-proxy:${p}` };
	const sameDestination = a.runtimeDestination === a.deployDestination;
	const envPorts = ports(root, p, existing);
	const deployPorts = sameDestination ? envPorts.runtime : envPorts.deploy;
	const files = [];
	const warnings = [];
	const put = (file, contents) => files.push([file, contents]);

	for (const script of SCRIPT_FILES) put(path.join("scripts", script), fs.readFileSync(path.join(TEMPLATES, script), "utf8"));

	put(`ui5-btp-${p}.yaml`, project.runtimeYaml(project.read(path.join(root, "ui5.yaml")), {
		port: envPorts.runtime.proxy,
		destination: a.runtimeDestination,
		script: scripts.start
	}));
	if (setupDeploy) {
		put(`ui5-deploy-btp-${p}.yaml`, project.deployYaml(root, {
			port: deployPorts.proxy,
			destination: a.deployDestination,
			client: a.abapClient,
			app: a.abapApp,
			pkg: a.abapPackage,
			transport: a.abapTransport,
			credentials: a.credentials,
			script: scripts.deploy
		}));
	} else {
		put(`ui5-deploy-btp-${p}.yaml`, null);
	}

	// undefined removes the key - the BTP_DEPLOY_* keys go when there is no deployment
	const envValues = {
		BTP_CF_API: a.cfApi,
		BTP_CF_ORG: a.org,
		BTP_CF_SPACE: a.space,
		BTP_CF_SSO: a.sso === undefined ? existing.BTP_CF_SSO : a.sso ? "true" : undefined,
		BTP_APP: a.app,
		BTP_DESTINATION: a.runtimeDestination,
		BTP_PROXY_PORT: envPorts.runtime.proxy,
		BTP_TUNNEL_PORT: envPorts.runtime.tunnel,
		BTP_DEPLOY_DESTINATION: setupDeploy ? a.deployDestination : undefined,
		BTP_DEPLOY_PROXY_PORT: setupDeploy && !sameDestination ? deployPorts.proxy : undefined,
		BTP_DEPLOY_TUNNEL_PORT: setupDeploy && !sameDestination ? deployPorts.tunnel : undefined
	};
	// a password left out keeps the one already in the file
	if (setupDeploy && a.credentials) {
		envValues.USR = a.deployUser;
		if (a.deployPassword !== undefined) envValues.SAP_PWD = a.deployPassword;
		else if (existing.SAP_PWD === undefined) envValues.SAP_PWD = "";
	}
	const envFile = `.env.${p}`;
	put(envFile, project.mergeEnv(project.read(path.join(root, envFile)), envValues, `${ENV_HEADER} - environment '${p}'`));

	// a project set up before environments existed: its settings moved to .env.<name>, the old files and scripts go
	if (prev.legacy) {
		const legacyKeys = Object.fromEntries([...LEGACY_ENV_KEYS, ...(a.credentials ? ["USR", "SAP_PWD"] : [])].map((k) => [k, undefined]));
		put(".env", project.mergeEnv(project.read(path.join(root, ".env")), legacyKeys));
		put("ui5-btp.yaml", null);
		put("ui5-deploy-btp.yaml", null);
	}

	const launch = project.launchJson(project.read(path.join(root, ".vscode", "launch.json")), p, { dropLegacy: prev.legacy });
	if (launch && launch.error) warnings.push(`${launch.error} - add a run configuration for 'npm run ${scripts.start}' yourself`);
	else if (launch) put(path.join(".vscode", "launch.json"), launch.text);

	const gitignoreBefore = project.read(path.join(root, ".gitignore"));
	let gitignore = gitignoreBefore;
	for (const entry of [".env", envFile]) gitignore = project.ensureGitignore(gitignore, entry) ?? gitignore;
	if (gitignore !== gitignoreBefore) put(".gitignore", gitignore);

	const pkgText = project.read(path.join(root, "package.json"));
	const pkg = JSON.parse(pkgText);
	pkg.scripts = { ...pkg.scripts };
	if (prev.legacy) for (const name of ["btp-proxy", "start-btp", "deploy-btp", "deploy-btp-test"]) delete pkg.scripts[name];
	Object.assign(pkg.scripts, {
		[scripts.proxy]: `node scripts/btp-proxy.js --profile ${p}`,
		[scripts.start]: `node scripts/btp.js start ${p}`
	});
	if (setupDeploy) {
		Object.assign(pkg.scripts, { [scripts.deploy]: `node scripts/btp.js deploy ${p}`, [scripts.deployTest]: `node scripts/btp.js deploy ${p} --test` });
	} else {
		delete pkg.scripts[scripts.deploy];
		delete pkg.scripts[scripts.deployTest];
	}
	const indent = (/^\{\r?\n([ \t]+)"/.exec(pkgText) || [])[1] || "  ";
	put("package.json", JSON.stringify(pkg, null, indent) + "\n");

	return { files, scripts, warnings };
}

module.exports = { plan, ports, profileEnv, authProblem, PROFILE_NAME, BSP_NAME, SUPPORTED_AUTH, ENV_HEADER };
