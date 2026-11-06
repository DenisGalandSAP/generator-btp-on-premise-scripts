#!/usr/bin/env node
"use strict";
/*
 * Non-interactive counterpart of the generator, used by the Claude Code plugin (claude-plugin/): every step of the
 * wizard is a command that prints JSON, and `apply` writes the environment with the same code as the generator.
 *
 *   btp-on-premise-setup <command> [--option value ...]
 *
 * Secrets never appear in the output: destination passwords / client secrets are dropped, SAP_PWD is masked.
 */
const fs = require("fs");
const path = require("path");
const { parseArgs } = require("util");
const project = require("../generators/app/lib/project");
const cf = require("../generators/app/lib/cf");
const regions = require("../generators/app/lib/regions");
const setup = require("../generators/app/lib/setup");
const adt = require("../generators/app/lib/adt");

const USAGE = `btp-on-premise-setup <command> [options] - prints JSON

  status     [--project <dir> --env <name>] [--user <email>] [--password-env <VAR>]
                                           cf API endpoint, login state, current org / space; the user and
                                           password variable the scripts log in with (from .env.<env>, the
                                           options, else CF_USERNAME / CF_PASSWORD) and whether it is set
  regions                                  SAP BTP Cloud Foundry regions and API endpoints
  login-url  --api <url>                   page that shows an SSO passcode for the endpoint
  login      --api <url> --passcode <code> cf login with an SSO passcode
  login      --api <url> [--project <dir> --env <name>] [--user <email>] [--password-env <VAR>] [--origin <idp>]
                                           cf auth with the password from the variable VAR; defaults from the
                                           environment's .env, then CF_USERNAME / CF_PASSWORD
  inspect    --project <dir> [--env <name>] [--abap]
                                           app kind (library: deploy only; abap: proxy for ABAP Development
                                           Tools), environments set up, defaults
  orgs
  spaces     --org <org>
  apps       --org <org> --space <space>   apps bound to a destination and a connectivity instance, with SSH state
  create-tunnel --org <org> --space <space>
                                           creates the 'btp-tunnel' app (and service instances when missing)
  destinations --org <org> --space <space> --app <app>
                                           OnPremise HTTP destinations the app can see
  apply      --project <dir> --env <name> --org <org> --space <space> --app <app> --destination <name>
             [--deploy-destination <name> --bsp <name> --package <pkg> [--transport <tr>] [--client <nnn>]
              [--deploy-user <user>]] [--sso | --no-sso] [--cf-user <email>] [--password-env <VAR>]
              [--origin <idp>] [--dry-run]
                                           writes the environment; the deploy password is read from the
                                           environment variable SAP_PWD (else left for the user to fill in).
                                           A SAPUI5 library is only deployed: --deploy-destination (or
                                           --destination) is the one destination, there is no start-btp.
                                           --abap: a folder for ABAP development (no ui5.yaml): only the proxy,
                                           with an https listener for ADT, and scripts/btp-mcp.js
  adt-cert   [--renew] [--dry-run]         localhost certificate of the https listener (~/.config/btp-proxy),
                                           trusted by the JRE of ABAP Development Tools for VS Code; prints the
                                           keytool commands for Eclipse ADT
  adt-mcp    --project <dir> --env <name> --vsp <path> [--name <mcp>] [--scope user|local|project]
             [--user <abap user>] [--client <nnn>] [--read-only] [--allowed-packages <list>]
                                           the 'claude mcp add' command for an ADT MCP server (vsp) that starts
                                           the environment's proxy first (nothing is registered here)`;

/** @type {import("util").ParseArgsConfig["options"]} */
const OPTIONS = {
	api: { type: "string" },
	passcode: { type: "string" },
	origin: { type: "string" },
	user: { type: "string" },
	"cf-user": { type: "string" },
	"password-env": { type: "string" },
	abap: { type: "boolean" },
	renew: { type: "boolean" },
	vsp: { type: "string" },
	name: { type: "string" },
	scope: { type: "string" },
	"read-only": { type: "boolean" },
	"allowed-packages": { type: "string" },
	project: { type: "string" },
	env: { type: "string" },
	org: { type: "string" },
	space: { type: "string" },
	app: { type: "string" },
	destination: { type: "string" },
	"deploy-destination": { type: "string" },
	bsp: { type: "string" },
	package: { type: "string" },
	transport: { type: "string" },
	client: { type: "string" },
	"deploy-user": { type: "string" },
	sso: { type: "boolean" },
	"no-sso": { type: "boolean" },
	"dry-run": { type: "boolean" },
	help: { type: "boolean", short: "h" }
};

const SECRET = /password|secret|token|key/i;
const SECRET_ENV = /PWD|PASSWORD|SECRET/i;

class UsageError extends Error {}

function need(opts, ...names) {
	const missing = names.filter((n) => !opts[n] || !String(opts[n]).trim());
	if (missing.length) throw new UsageError(`Missing ${missing.map((n) => `--${n}`).join(", ")}`);
}

const maskEnv = (values) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, SECRET_ENV.test(k) && v ? "***" : v]));

async function findSpace(org, space) {
	const o = (await cf.orgs()).find((x) => x.name === org);
	if (!o) throw new Error(`Org '${org}' not found`);
	const s = (await cf.spaces(o.guid)).find((x) => x.name === space);
	if (!s) throw new Error(`Space '${space}' not found in org '${org}'`);
	return s;
}

async function findApp(opts) {
	const s = await findSpace(opts.org, opts.space);
	const apps = await cf.boundApps(s.guid);
	const app = apps.find((x) => x.name === opts.app);
	if (!app) {
		throw new Error(`'${opts.app}' is not bound to both a destination and a connectivity instance in ${opts.org}/${opts.space}` +
			(apps.length ? ` - bound apps: ${apps.map((x) => x.name).join(", ")}` : " - run create-tunnel"));
	}
	return app;
}

// OnPremise HTTP destinations, without credentials
/** @returns {Promise<Array<Record<string, any> & { supported: boolean, problem?: string }>>} */
async function onPremiseDestinations(appGuid) {
	return (await cf.destinations(appGuid))
		.filter((d) => d.ProxyType === "OnPremise" && (d.Type || "HTTP") === "HTTP")
		.map((d) => {
			/** @type {Record<string, any>} */
			const clean = Object.fromEntries(Object.entries(d).filter(([k]) => !SECRET.test(k)));
			const problem = setup.authProblem(d);
			return { ...clean, supported: !problem, ...(problem ? { problem } : {}) };
		});
}

/** User and password for cf auth: options, then the environment's .env values, then CF_USERNAME / CF_PASSWORD. */
function credentials(opts, env = {}) {
	const user = (opts.user || env.BTP_CF_USER || process.env.CF_USERNAME || "").trim();
	const passwordVar = (opts["password-env"] || env.BTP_CF_PASSWORD_ENV || "CF_PASSWORD").trim();
	const origin = (opts.origin !== undefined ? opts.origin : env.BTP_CF_ORIGIN || "").trim();
	return { user, passwordVar, origin, password: process.env[passwordVar] || "" };
}

/** Values of the environment named by --project / --env, or {} without them. */
const envValues = (opts) => (opts.project && opts.env ? setup.profileEnv(path.resolve(opts.project), opts.env.trim().toLowerCase()).values : {});

const commands = {
	async "adt-cert"(opts) {
		const { cert, created } = adt.ensureCert({ renew: !!opts.renew, dryRun: !!opts["dry-run"] });
		const vscode = adt.vscodeJres().map(({ extension, jre }) => {
			if (!created && adt.trusted(jre, cert)) return { extension, jre, status: "already trusted" };
			if (opts["dry-run"]) return { extension, jre, status: "would import" };
			try {
				adt.trust(jre, cert);
				return { extension, jre, status: "imported - reload the VS Code window" };
			} catch (e) {
				return { extension, jre, status: `failed: ${(e.stderr || e.message).toString().trim().split("\n").pop()}` };
			}
		});
		return {
			cert,
			created,
			vscode,
			// several installs can run on the same Java (eclipse.ini -vm): one import each
			eclipse: Object.values(adt.eclipseJres().reduce((byJre, e) => {
				if (byJre[e.jre]) byJre[e.jre].installs.push(adt.eclipseCommands(e, cert).install);
				else byJre[e.jre] = { ...adt.eclipseCommands(e, cert), installs: [adt.eclipseCommands(e, cert).install], source: e.source };
				return byJre;
			}, {})).map(({ install, ...rest }) => rest),
			note: "Redo after an ADT extension or Eclipse update (new JRE folder). Eclipse must be closed for its import."
		};
	},

	async "adt-mcp"(opts) {
		need(opts, "project", "env", "vsp", "user");
		const info = project.inspect(opts.project);
		if (project.failed(info)) throw new Error(info.error);
		if (!info.abap) throw new UsageError("--project: not set up for ABAP development (apply --abap first)");
		const env = opts.env.trim().toLowerCase();
		const values = setup.profileEnv(info.root, env).values;
		if (!values.BTP_DESTINATION) throw new Error(`No environment '${env}' in ${info.root}`);
		const scope = opts.scope || "local";
		if (!["user", "local", "project"].includes(scope)) throw new UsageError("--scope: user, local or project");
		if (opts.client && !/^\d{3}$/.test(opts.client)) throw new UsageError("--client: three digits");
		const name = opts.name || `abap-adt-${env}`;
		const command = adt.mcpCommand({
			root: info.root, env, values, vsp: opts.vsp, name, scope,
			user: opts.user.trim().toUpperCase(), client: opts.client || values.BTP_SAP_CLIENT,
			readOnly: !!opts["read-only"], allowedPackages: opts["allowed-packages"]
		});
		return {
			name,
			command,
			http: `http://127.0.0.1:${values.BTP_PROXY_PORT || 5050}`,
			https: values.BTP_PROXY_TLS_PORT ? `https://127.0.0.1:${values.BTP_PROXY_TLS_PORT}` : undefined
		};
	},

	async status(opts = {}) {
		const status = await cf.loginStatus().catch((e) => ({ loggedIn: false, error: e.message }));
		const env = envValues(opts);
		const login = credentials(opts, env);
		const sso = env.BTP_CF_SSO === "true";
		// the user and the variable name are not secrets; only whether the password is set is printed
		return {
			...status,
			...(opts.project && opts.env ? { environment: { api: env.BTP_CF_API, org: env.BTP_CF_ORG, space: env.BTP_CF_SPACE, app: env.BTP_APP, sso: env.BTP_CF_SSO === "true", origin: env.BTP_CF_ORIGIN || "" } } : {}),
			envUser: login.user,
			passwordEnv: login.passwordVar,
			passwordSet: !!login.password,
			origin: login.origin,
			// whether the scripts can log in on their own (never for single sign-on)
			envCredentials: !sso && !!(login.user && login.password)
		};
	},

	async regions() {
		return regions.list();
	},

	async "login-url"(opts) {
		need(opts, "api");
		return { passcodeUrl: `${await cf.loginUrl(opts.api)}/passcode` };
	},

	async login(opts) {
		need(opts, "api");
		const api = opts.api.trim().replace(/\/+$/, "");
		if (opts.passcode) {
			await cf.loginWithPasscode(api, opts.passcode.trim());
		} else {
			const { user, passwordVar, password, origin } = credentials(opts, envValues(opts));
			if (!user) throw new Error("Give --passcode, or --user (or set CF_USERNAME)");
			if (!password) throw new Error(`The variable ${passwordVar} is not set in the environment Claude / the CLI runs in`);
			await cf.loginWithPassword(api, user, password, origin);
		}
		return cf.loginStatus();
	},

	async inspect(opts) {
		need(opts, "project");
		const info = project.inspect(opts.project, { abap: !!opts.abap });
		if (project.failed(info)) {
			const candidates = project.findProjects([path.resolve(opts.project)]);
			return { error: info.error, ...(candidates.length ? { candidates } : {}) };
		}
		const env = (opts.env || project.profiles(info.root)[0] || "dev").trim().toLowerCase();
		const prev = setup.profileEnv(info.root, env);
		return {
			root: info.root,
			id: info.id,
			kind: info.kind,
			library: !!info.library,
			abap: !!info.abap,
			hasBuildScript: info.hasBuildScript,
			environments: project.profiles(info.root),
			env,
			existing: maskEnv(prev.values),
			legacySetup: prev.legacy,
			runtimeDestinations: project.runtimeDestinations(info.root),
			deployDefaults: project.deployDefaults(info.root, env)
		};
	},

	async orgs() {
		return (await cf.orgs()).map((o) => o.name);
	},

	async spaces(opts) {
		need(opts, "org");
		const o = (await cf.orgs()).find((x) => x.name === opts.org);
		if (!o) throw new Error(`Org '${opts.org}' not found`);
		return (await cf.spaces(o.guid)).map((s) => s.name);
	},

	async apps(opts) {
		need(opts, "org", "space");
		const s = await findSpace(opts.org, opts.space);
		const apps = await cf.boundApps(s.guid);
		return Promise.all(apps.map(async (a) => {
			const ssh = await cf.sshEnabled(a.guid).catch((e) => ({ enabled: false, reason: e.message }));
			return { name: a.name, sshEnabled: !!ssh.enabled, ...(ssh.enabled ? {} : { sshReason: ssh.reason || "disabled" }) };
		}));
	},

	async "create-tunnel"(opts) {
		need(opts, "org", "space");
		const s = await findSpace(opts.org, opts.space);
		const log = [];
		const app = await cf.createTunnelApp(opts.org, opts.space, s.guid, (msg) => {
			log.push(msg);
			process.stderr.write(msg + "\n");
		});
		return { app, log };
	},

	async destinations(opts) {
		need(opts, "org", "space", "app");
		return onPremiseDestinations((await findApp(opts)).guid);
	},

	async apply(opts) {
		need(opts, "project", "env", "org", "space", "app");
		const info = project.inspect(opts.project, { abap: !!opts.abap });
		if (project.failed(info)) throw new Error(info.error);
		// an ABAP folder only gets the proxy: no deployment through it
		if (info.abap && opts["deploy-destination"]) throw new UsageError("--deploy-destination: an ABAP folder has no deployment, give --destination only");
		// a library has nothing to run - its one destination is the deploy destination
		if (info.library) opts = { ...opts, "deploy-destination": opts["deploy-destination"] || opts.destination };
		need(opts, info.library ? "deploy-destination" : "destination");
		const profile = opts.env.trim().toLowerCase();
		if (!setup.PROFILE_NAME.test(profile)) throw new UsageError("--env: letters, digits, - and _ (e.g. dev, qual)");
		const deploy = !!opts["deploy-destination"];
		const upper = (v) => (v || "").trim().toUpperCase();
		const answers = {
			profile,
			org: opts.org,
			space: opts.space,
			app: opts.app,
			runtimeDestination: info.library ? opts["deploy-destination"] : opts.destination,
			deployDestination: deploy ? opts["deploy-destination"] : undefined,
			library: !!info.library,
			abap: !!info.abap,
			abapApp: upper(opts.bsp),
			abapPackage: upper(opts.package),
			abapTransport: upper(opts.transport),
			abapClient: (opts.client || "").trim(),
			sso: opts.sso ? true : opts["no-sso"] ? false : undefined,
			origin: opts.origin === undefined ? undefined : opts.origin.trim(),
			cfUser: opts["cf-user"],
			passwordEnv: opts["password-env"]
		};
		if (answers.passwordEnv && !setup.ENV_NAME.test(answers.passwordEnv.trim())) throw new UsageError("--password-env: a variable name (letters, digits, _), e.g. CF_PASSWORD");
		if (deploy) {
			need(opts, "bsp", "package");
			if (!setup.BSP_NAME.test(answers.abapApp) || answers.abapApp.length > 15) throw new UsageError("--bsp: up to 15 characters, letters, digits, _ and an optional /NAMESPACE/");
			if (!answers.abapTransport && !/^\$/.test(answers.abapPackage)) throw new UsageError("--transport is required for a non-local package");
			if (answers.abapClient && !/^\d{3}$/.test(answers.abapClient)) throw new UsageError("--client: three digits, e.g. 100");
		}

		const status = await cf.loginStatus();
		if (!status.loggedIn) throw new Error(`Not logged in to Cloud Foundry (${status.error || "no session"}) - log in first`);
		const app = await findApp(opts);
		const ssh = await cf.sshEnabled(app.guid);
		if (!ssh.enabled) throw new Error(`SSH is disabled for '${app.name}' (${ssh.reason || "disabled"}) - run: cf enable-ssh ${app.name} && cf restart ${app.name}`);
		const dests = await cf.destinations(app.guid);
		const check = (name) => {
			const d = dests.find((x) => x.Name === name && x.ProxyType === "OnPremise" && (x.Type || "HTTP") === "HTTP");
			if (!d) throw new Error(`'${name}' is not an OnPremise HTTP destination visible to '${app.name}'`);
			const problem = setup.authProblem(d);
			if (problem) throw new Error(problem);
			return d;
		};
		check(answers.runtimeDestination);
		const warnings = [];
		if (deploy) {
			const d = check(answers.deployDestination);
			answers.credentials = d.Authentication === "NoAuthentication";
			if (answers.credentials) {
				need(opts, "deploy-user");
				answers.deployUser = opts["deploy-user"].trim();
				answers.deployPassword = process.env.SAP_PWD || undefined;
				if (!answers.deployPassword && !setup.profileEnv(info.root, profile).values.SAP_PWD) {
					warnings.push(`SAP_PWD in .env.${profile} is empty - enter the ABAP password of ${answers.deployUser} there before deploying`);
				}
			}
		}
		answers.cfApi = status.api;

		const result = setup.plan(info.root, answers);
		const written = [];
		const removed = [];
		for (const [file, contents] of result.files) {
			const target = path.join(info.root, file);
			if (contents === null) {
				if (!fs.existsSync(target)) continue;
				if (!opts["dry-run"]) fs.rmSync(target);
				removed.push(file);
				continue;
			}
			if (project.read(target) === contents) continue;
			if (!opts["dry-run"]) {
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, contents);
			}
			written.push(file);
		}
		if (!opts["dry-run"]) {
			await cf.target(answers.org, answers.space).catch((e) => warnings.push(`Could not run 'cf target': ${e.message}`));
		}
		return {
			dryRun: !!opts["dry-run"],
			root: info.root,
			env: profile,
			written,
			removed,
			scripts: Object.fromEntries(Object.entries(result.scripts).filter(([k]) => deploy || k === "start" || k === "proxy").map(([k, v]) => [k, `npm run ${v}`])),
			warnings: [...result.warnings, ...warnings]
		};
	}
};

async function main(argv) {
	const [command, ...rest] = argv;
	if (!command || command === "help" || command === "--help" || command === "-h") {
		console.log(USAGE);
		return 0;
	}
	const run = commands[command];
	if (!run) {
		console.error(`Unknown command '${command}'\n\n${USAGE}`);
		return 2;
	}
	try {
		const { values } = parseArgs({ args: rest, options: OPTIONS, strict: true, allowPositionals: false });
		const result = await run(values);
		console.log(JSON.stringify(result, null, 2));
		return 0;
	} catch (e) {
		console.log(JSON.stringify({ error: e.message }, null, 2));
		return e instanceof UsageError || e.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? 2 : 1;
	}
}

if (require.main === module) main(process.argv.slice(2)).then((code) => (process.exitCode = code));

module.exports = { main, commands };
