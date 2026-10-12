"use strict";
/*
 * Adds scripts/btp-proxy.js + scripts/btp.js to a SAPUI5 / SAP Fiori elements project so it can run and
 * deploy through on-premise BTP destinations (cf ssh tunnel to the connectivity proxy of a CF app).
 *
 * One run sets up one environment (dev, qual, ...): .env.<name>, ui5-btp-<name>.yaml, ui5-deploy-btp-<name>.yaml and
 * the npm scripts start-btp:<name> / deploy-btp:<name>; each environment keeps its own API endpoint, org, space and ports.
 *
 * Steps: project + environment -> Cloud Foundry endpoint + login (only when needed) -> org / space / app -> runtime + optional
 * deploy destination -> deploy target and credentials (only with a deploy destination; credentials when it has
 * no authentication).
 */
const Generator = require("yeoman-generator");
const path = require("path");
const { Prompts } = require("@sap-devx/yeoman-ui-types");
const project = require("./lib/project");
const cf = require("./lib/cf");
const regions = require("./lib/regions");

const STEPS = {
	project: { name: "Project", description: "SAPUI5 or SAP Fiori elements project to add the BTP destination scripts to" },
	endpoint: { name: "Cloud Foundry Endpoint", description: "Region of the subaccount the environment lives in (asked when not logged in, the session expired or another region was chosen)" },
	login: { name: "Cloud Foundry Login", description: "Log on to the Cloud Foundry environment of the subaccount" },
	target: { name: "Cloud Foundry Target", description: "Org and space of the CF app the local proxy tunnels through (bound to the destination and connectivity services, SSH enabled) - picked automatically when there is only one, created when there is none" },
	destinations: { name: "Destinations", description: "Destination used to run the app and, optionally, destination used to deploy it" },
	deploy: { name: "Deployment", description: "ABAP repository target and logon for the deploy destination" }
};

const DIRECT_ACCESS_NOTE =
	"Note: if the SAP system is reachable directly from your environment, you do not need this generator - " +
	"add the system with the Service Center of SAP Fiori tools instead.";

const OTHER_ENDPOINT = "other";
const CURRENT_SESSION = "current";
const OTHER_SESSION = "login";
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

const SUPPORTED_AUTH = ["NoAuthentication", "BasicAuthentication"];
const RUNTIME_PORTS = { proxy: 5050, tunnel: 20003 };
const DEPLOY_PORTS = { proxy: 5051, tunnel: 20004 };
const PORT_KEYS = ["BTP_PROXY_PORT", "BTP_TUNNEL_PORT", "BTP_DEPLOY_PROXY_PORT", "BTP_DEPLOY_TUNNEL_PORT"];
// keys a project set up before environments existed has in .env
const LEGACY_ENV_KEYS = ["BTP_APP", "BTP_CF_ORG", "BTP_CF_SPACE", "BTP_DESTINATION", "BTP_DEPLOY_DESTINATION", ...PORT_KEYS];
const ENV_HEADER ="SAP BTP on-premise access (@scodigis/generator-btp-on-premise-scripts)";

const required = (label) => (value) => (value && String(value).trim() ? true : `${label} is required`);

module.exports = class extends Generator {
	constructor(args, opts) {
		super(args, opts);
		this.isGui = !!opts.vscode; // running inside the Template Wizard (yeoman-ui)
		this.vscode = opts.vscode;
		this.prompts = new Prompts([STEPS.project, STEPS.target, STEPS.destinations, STEPS.deploy]);
		this.setPromptsCallback = (fn) => {
			if (this.prompts) this.prompts.setCallback(fn);
		};
		// package.json only gets scripts - no need for the automatic npm install
		if (this.env && this.env.options) this.env.options.skipInstall = true;
		this.cache = { orgs: undefined, spaces: new Map(), apps: new Map(), destinations: new Map() };
		this.answers = {};
	}

	async initializing() {
		this.cfStatus = await cf.loginStatus().catch((e) => ({ loggedIn: false, error: e.message }));
		if (!this.cfStatus.loggedIn) this.prompts.splice(1, 0, [STEPS.endpoint, STEPS.login]);
	}

	_label(name, message, when) {
		return { type: "input", name, message, when: this.isGui ? when || true : false, guiOptions: { type: "label" } };
	}

	/* ---------- 1. project ---------- */

	_defaultProjectPath() {
		const folders = [];
		const ws = this.vscode && this.vscode.workspace && this.vscode.workspace.workspaceFolders;
		if (ws) folders.push(...ws.map((f) => f.uri.fsPath));
		folders.push(process.cwd());
		return project.findProjects([...new Set(folders)])[0] || (ws && ws[0] && ws[0].uri.fsPath) || process.cwd();
	}

	async _promptProject() {
		if (!this.isGui) this.log(DIRECT_ACCESS_NOTE);
		const answers = await this.prompt([
			this._label("directAccessNote", DIRECT_ACCESS_NOTE),
			{
				type: "input",
				name: "projectPath",
				message: "Project folder",
				default: this._defaultProjectPath(),
				guiOptions: { type: "folder-browser", mandatory: true, hint: "Root folder of the app (contains package.json, ui5.yaml and webapp/manifest.json)" },
				validate: (value) => {
					const info = project.inspect(value);
					return info.error || true;
				}
			},
			this._label("projectInfo", (a) => {
				const info = project.inspect(a.projectPath);
				if (info.error) return "";
				const notes = [`${info.kind} app '${info.id}'`];
				if (!info.hasBuildScript) notes.push("WARNING: package.json has no 'build' script, deploy-btp needs one");
				const existing = project.profiles(info.root);
				if (existing.length) notes.push(`environments set up: ${existing.join(", ")}`);
				return notes.join(" - ");
			}),
			{
				type: "input",
				name: "profile",
				message: "Environment",
				default: (a) => project.profiles(a.projectPath)[0] || "dev",
				guiOptions: {
					mandatory: true,
					hint: "e.g. dev, qual, prod - each environment gets its own .env.<name>, ui5-btp-<name>.yaml and npm scripts (start-btp:<name>...). " +
						"Run the generator again with another name to add one, with an existing name to change it"
				},
				validate: (v) => (PROFILE_NAME.test((v || "").trim()) ? true : "Letters, digits, - and _ (e.g. dev, qual)"),
				filter: (v) => (v || "").trim().toLowerCase()
			},
			{
				type: "list",
				name: "cfSession",
				message: "Cloud Foundry",
				choices: () => [
					{ name: `Use the current session: ${this.cfStatus.api} as ${this.cfStatus.user || "?"}`, value: CURRENT_SESSION },
					{ name: "Log in to another region / subaccount", value: OTHER_SESSION }
				],
				// an environment set up on another API endpoint logs in there again
				default: (a) => {
					const api = this._profileEnv(a.projectPath, (a.profile || "").trim().toLowerCase()).values.BTP_CF_API;
					return api && !cf.sameApi(api, this.cfStatus.api) ? OTHER_SESSION : CURRENT_SESSION;
				},
				when: () => this.cfStatus.loggedIn,
				guiOptions: { hint: "Orgs of every subaccount in the same region are reachable with the current session; another region needs a login" }
			}
		]);
		this.project = project.inspect(answers.projectPath);
		this.profile = (answers.profile || "dev").trim().toLowerCase();
		const prev = this._profileEnv(this.project.root, this.profile);
		this.existingEnv = prev.values;
		this.migrateLegacy = prev.legacy;
		this.cfSession = answers.cfSession || CURRENT_SESSION;
		if (!this.isGui) this.log(`${this.project.kind} app '${this.project.id}', environment '${this.profile}'`);
	}

	// settings of an environment - a project set up before environments existed has them in .env
	_profileEnv(root, profile) {
		const own = project.read(path.join(root || "", `.env.${profile}`));
		if (own !== undefined) return { values: project.parseEnv(own), legacy: false };
		const legacy = project.parseEnv(project.read(path.join(root || "", ".env")));
		return legacy.BTP_APP ? { values: legacy, legacy: true } : { values: {}, legacy: false };
	}

	/* ---------- 2. login ---------- */

	// SAP BTP Cloud Foundry regions, as offered by the Cloud Connector when adding a subaccount
	// API endpoint of the environment when it has one, else the one the cf CLI points at
	_preferredApi() {
		return (this.existingEnv.BTP_CF_API || this.cfStatus.api || "").replace(/\/+$/, "");
	}

	async _endpointChoices() {
		if (!this.regions) this.regions = await regions.list();
		const choices = this.regions.regions.map((r) => ({ name: `${r.key}  -  ${r.location} - ${r.provider}  (${r.api})`, value: r.api }));
		const known = [
			[this.existingEnv.BTP_CF_API, `environment '${this.profile}'`],
			[this.cfStatus.api, "current cf target"]
		];
		for (const [api, origin] of known.reverse()) {
			const value = (api || "").replace(/\/+$/, "");
			if (value && !choices.some((c) => c.value === value)) choices.unshift({ name: `${value}  (${origin})`, value });
		}
		choices.push({ name: "Other - enter the API endpoint", value: OTHER_ENDPOINT });
		return choices;
	}

	async _promptLogin() {
		const endpoint = await this.prompt([
			this._label("loginInfo", () => {
				if (this.cfStatus.loggedIn) return `Currently logged in to ${this.cfStatus.api} as ${this.cfStatus.user || "?"} - select the region of the subaccount of '${this.profile}'.`;
				return this.cfStatus.api
					? `The Cloud Foundry session for ${this.cfStatus.api} is not valid anymore${this.cfStatus.error ? ` (${this.cfStatus.error})` : ""}.`
					: "The cf CLI has no API endpoint yet.";
			}),
			{
				type: "list",
				name: "cfRegion",
				message: "Region (API endpoint)",
				choices: () => this._endpointChoices(),
				default: this._preferredApi() || "https://api.cf.eu10.hana.ondemand.com",
				guiOptions: {
					mandatory: true,
					hint: "Cloud Foundry API endpoint of the subaccount, see the subaccount overview in the BTP cockpit (regions listed from SAP Help, built-in list when offline)"
				}
			},
			{
				type: "input",
				name: "cfApi",
				message: "API endpoint",
				when: (a) => a.cfRegion === OTHER_ENDPOINT,
				guiOptions: { mandatory: true, hint: "e.g. https://api.cf.eu10.hana.ondemand.com" },
				validate: (v) => (/^https:\/\/\S+$/.test(v || "") ? true : "Enter an https:// URL")
			},
			{
				type: "list",
				name: "cfLoginMethod",
				message: "Log in with",
				choices: [
					{ name: "Single sign-on (temporary passcode)", value: "sso" },
					{ name: "User and password", value: "password" }
				],
				default: "sso"
			}
		]);
		const api = (endpoint.cfRegion === OTHER_ENDPOINT ? endpoint.cfApi : endpoint.cfRegion).trim().replace(/\/+$/, "");
		if (!/^https:\/\/\S+$/.test(api)) throw new Error(`Invalid API endpoint: ${api}`);
		const sso = endpoint.cfLoginMethod === "sso";
		const passcodeUrl = sso ? `${await cf.loginUrl(api)}/passcode` : undefined;

		// validate runs again on "Next" - a passcode is single-use, so never log in twice with the same input
		let loggedInWith;
		const login = async (key, doLogin) => {
			if (loggedInWith === key) return true;
			try {
				await doLogin();
			} catch (e) {
				return `Login failed: ${e.message}`;
			}
			this.cfStatus = await cf.loginStatus();
			if (!this.cfStatus.loggedIn) return `Login did not succeed: ${this.cfStatus.error || "unknown error"}`;
			loggedInWith = key;
			return true;
		};
		const loginWith = (a) =>
			sso
				? login(`sso|${api}|${a.cfPasscode}`, () => cf.loginWithPasscode(api, a.cfPasscode.trim()))
				: login(`pwd|${api}|${a.cfUser}|${a.cfOrigin}|${a.cfPassword}`, () =>
					cf.loginWithPassword(api, a.cfUser.trim(), a.cfPassword, (a.cfOrigin || "").trim()));
		const credentials = await this.prompt([
			this._label("loginEndpoint", () => `Logging in to ${api}`),
			{
				type: "password",
				name: "cfPasscode",
				// the wizard shows a link next to the label, the CLI needs the URL in the text
				message: this.isGui ? "Temporary authentication code" : `Temporary authentication code - open ${passcodeUrl} to get one`,
				when: () => sso,
				guiOptions: {
					mandatory: true,
					type: "login",
					link: { text: "Get a passcode", url: passcodeUrl },
					hint: `Log on at ${passcodeUrl} and paste the code shown there`
				},
				validate: async (code) => (code ? loginWith({ cfPasscode: code }) : "Enter the passcode")
			},
			{
				type: "input",
				name: "cfUser",
				message: "User (e-mail)",
				when: () => !sso,
				guiOptions: { mandatory: true },
				validate: required("User")
			},
			{
				type: "input",
				name: "cfOrigin",
				message: "Identity provider origin (optional)",
				when: () => !sso,
				guiOptions: { hint: "Only for a custom identity provider (cf auth --origin), e.g. 'sap.custom' - leave empty for the SAP ID service" }
			},
			{
				type: "password",
				name: "cfPassword",
				message: "Password",
				when: () => !sso,
				guiOptions: { mandatory: true, type: "login" },
				validate: async (password, a) => {
					if (!password) return "Enter the password";
					if (!a.cfUser) return "Enter the user first";
					return loginWith({ ...a, cfPassword: password });
				}
			}
		]);
		// not every prompt implementation runs validate
		if (!loggedInWith) await this._check(loginWith(credentials));
		// the scripts log in again the same way when the session expires
		this.loginSso = sso;
		// orgs / spaces / apps of the previous session do not apply anymore
		this.cache = { orgs: undefined, spaces: new Map(), apps: new Map(), destinations: new Map() };
	}

	/* ---------- 3. org / space / app ---------- */

	async _orgs() {
		if (!this.cache.orgs) this.cache.orgs = await cf.orgs();
		return this.cache.orgs;
	}

	async _spaces(orgName) {
		const org = (await this._orgs()).find((o) => o.name === orgName);
		if (!org) return [];
		if (!this.cache.spaces.has(org.guid)) this.cache.spaces.set(org.guid, await cf.spaces(org.guid));
		return this.cache.spaces.get(org.guid);
	}

	async _apps(orgName, spaceName) {
		const space = (await this._spaces(orgName)).find((s) => s.name === spaceName);
		if (!space) return [];
		if (!this.cache.apps.has(space.guid)) this.cache.apps.set(space.guid, await cf.boundApps(space.guid));
		return this.cache.apps.get(space.guid);
	}

	async _check(result) {
		const value = await result;
		if (value !== true) throw new Error(value);
	}

	async _validateApp(name, a) {
		const apps = await this._apps(a.org, a.space);
		if (!apps.length) return `No app in ${a.org}/${a.space} is bound to both a destination and a connectivity service instance - let the generator create one, or see 'First-time setup' in the README`;
		const app = apps.find((x) => x.name === name);
		if (!app) return "Select an app";
		const ssh = await cf.sshEnabled(app.guid);
		if (!ssh.enabled) return `SSH is disabled for '${name}' (${ssh.reason || "disabled"}) - run: cf enable-ssh ${name} && cf restart ${name}`;
		return true;
	}

	async _promptTarget() {
		const prev = this.existingEnv;
		const answers = await this.prompt([
			this._label("targetInfo", () => `Logged in to ${this.cfStatus.api} as ${this.cfStatus.user || "?"}`),
			{
				type: "list",
				name: "org",
				message: "Organization",
				choices: async () => (await this._orgs()).map((o) => o.name),
				default: prev.BTP_CF_ORG || this.cfStatus.org,
				guiOptions: { mandatory: true },
				validate: required("Organization")
			},
			{
				type: "list",
				name: "space",
				message: "Space",
				choices: async (a) => (await this._spaces(a.org)).map((s) => s.name),
				default: async (a) => {
					const names = (await this._spaces(a.org)).map((s) => s.name);
					return [prev.BTP_CF_SPACE, this.cfStatus.space].find((n) => names.includes(n));
				},
				guiOptions: { mandatory: true },
				validate: required("Space")
			},
			{
				type: "list",
				name: "app",
				message: "App bound to the destination and connectivity services",
				choices: async (a) => (a.org && a.space ? (await this._apps(a.org, a.space)).map((x) => x.name) : []),
				default: prev.BTP_APP,
				// only ask when there is a choice - a single bound app is picked automatically, none is created (below)
				when: async (a) => !!a.org && !!a.space && (await this._apps(a.org, a.space)).length > 1,
				guiOptions: {
					mandatory: true,
					hint: "The local proxy reads the service keys from this app's environment and opens 'cf ssh' through it to the connectivity proxy"
				},
				validate: (name, a) => this._validateApp(name, a)
			},
			{
				type: "confirm",
				name: "createTunnel",
				message: (a) =>
					`No app in ${a.org}/${a.space} is bound to a destination and a connectivity service yet. ` +
					`Create the app '${cf.TUNNEL.app}' for the tunnel (64 MB, binds or creates the '${cf.TUNNEL.destination}' and '${cf.TUNNEL.connectivity}' instances)?`,
				default: true,
				when: async (a) => !!a.org && !!a.space && !(await this._apps(a.org, a.space)).length,
				guiOptions: {
					hint: "Needs the entitlements Destination (lite), Connectivity (lite) and Cloud Foundry Runtime memory - see 'First-time setup' in the README to do it by hand"
				},
				validate: (create) => create || "The proxy needs such an app - select another space, or set it up by hand (README, 'First-time setup')"
			}
		]);
		const apps = await this._apps(answers.org, answers.space);
		if (!apps.length && answers.createTunnel) {
			const space = (await this._spaces(answers.org)).find((s) => s.name === answers.space);
			this.log(`Creating the tunnel app in ${answers.org}/${answers.space} - this takes a minute or two`);
			answers.app = await cf.createTunnelApp(answers.org, answers.space, space.guid, (msg) => this.log(msg));
			this.cache.apps.delete(space.guid);
		} else if (!answers.app && apps.length === 1) {
			answers.app = apps[0].name;
		}
		// the yo CLI does not validate list answers
		await this._check(this._validateApp(answers.app, answers));
		Object.assign(this.answers, answers);
		this.app = (await this._apps(answers.org, answers.space)).find((x) => x.name === answers.app);
		if (!this.isGui) this.log(`Using app '${this.app.name}' for the tunnel to the connectivity proxy`);
	}

	/* ---------- 4. destinations ---------- */

	async _destinations() {
		const key = this.app.guid;
		if (!this.cache.destinations.has(key)) this.cache.destinations.set(key, await cf.destinations(key));
		return this.cache.destinations.get(key).filter((d) => d.ProxyType === "OnPremise" && (d.Type || "HTTP") === "HTTP");
	}

	async _destination(name) {
		return (await this._destinations()).find((d) => d.Name === name);
	}

	async _destinationChoices() {
		return (await this._destinations()).map((d) => ({
			name: `${d.Name}  -  ${d.URL}${d["sap-client"] ? `  client ${d["sap-client"]}` : ""}  (${d.Authentication}${d.level === "instance" ? ", instance" : ""})`,
			value: d.Name
		}));
	}

	_authProblem(d) {
		if (!d) return "Select a destination";
		if (!SUPPORTED_AUTH.includes(d.Authentication)) {
			return `'${d.Name}' uses ${d.Authentication}; the local proxy has no user token, only ${SUPPORTED_AUTH.join(" / ")} work`;
		}
		return undefined;
	}

	// first name that is one of the available destinations
	async _knownDestination(...names) {
		const available = (await this._destinations()).map((d) => d.Name);
		return names.find((n) => n && available.includes(n));
	}

	async _promptDestinations() {
		const prev = this.existingEnv;
		// destinations of the existing ui5.yaml / ui5-deploy.yaml, used when .env has none yet
		const deployDest = project.deployDefaults(this.project.root, this.profile).destination;
		const runtimeDests = project.runtimeDestinations(this.project.root);
		const describe = async (name, purpose) => {
			const d = await this._destination(name);
			if (!d) return "";
			if (d.Authentication === "BasicAuthentication") return `${purpose}: logon as ${d.User || "the destination user"} (taken from the destination)`;
			return `${purpose}: the destination has no authentication - ${purpose === "Deploy" ? "the ABAP user and password are asked on the next step" : "the browser asks for the logon"}`;
		};
		const validateDestination = async (name) => {
			if (!(await this._destinations()).length) return `No OnPremise HTTP destination is visible to '${this.app.name}'`;
			return this._authProblem(await this._destination(name)) || true;
		};
		const answers = await this.prompt([
			{
				type: "list",
				name: "runtimeDestination",
				message: "Runtime destination (npm run start-btp)",
				choices: () => this._destinationChoices(),
				default: () => this._knownDestination(prev.BTP_DESTINATION, ...runtimeDests, deployDest),
				guiOptions: { mandatory: true, hint: "OData / backend calls of the running app go through this destination" },
				validate: validateDestination
			},
			this._label("runtimeAuthInfo", (a) => describe(a.runtimeDestination, "Runtime")),
			{
				type: "confirm",
				name: "setupDeploy",
				message: "Also deploy through a BTP destination (npm run deploy-btp)",
				// off only when an earlier run left it out
				default: !(prev.BTP_DESTINATION && !prev.BTP_DEPLOY_DESTINATION),
				guiOptions: { hint: "Leave unchecked to only run the app through the destination - the Deployment step is skipped" }
			},
			{
				type: "list",
				name: "deployDestination",
				message: "Deploy destination (npm run deploy-btp)",
				choices: () => this._destinationChoices(),
				default: (a) => this._knownDestination(prev.BTP_DEPLOY_DESTINATION, deployDest, a.runtimeDestination),
				when: (a) => a.setupDeploy !== false,
				guiOptions: { mandatory: true, hint: "The ABAP repository upload (/sap/opu/odata/UI5/ABAP_REPOSITORY_SRV) goes through this destination" },
				validate: validateDestination
			},
			this._label("deployAuthInfo", (a) => describe(a.deployDestination, "Deploy"), (a) => a.setupDeploy !== false)
		]);
		this.setupDeploy = answers.setupDeploy !== false;
		await this._check(validateDestination(answers.runtimeDestination));
		if (this.setupDeploy) await this._check(validateDestination(answers.deployDestination));
		else delete answers.deployDestination;
		Object.assign(this.answers, answers);
		this.runtimeDest = await this._destination(answers.runtimeDestination);
		this.deployDest = this.setupDeploy ? await this._destination(answers.deployDestination) : undefined;
		// no deployment - drop the Deployment step from the wizard
		const deployStep = this.prompts.items.indexOf(STEPS.deploy);
		if (!this.setupDeploy && deployStep >= 0) this.prompts.splice(deployStep, 1);
	}

	/* ---------- 5. deploy ---------- */

	async _promptDeploy() {
		const prev = this.existingEnv;
		const defaults = project.deployDefaults(this.project.root, this.profile);
		this.needsCredentials = this.deployDest.Authentication === "NoAuthentication";
		const answers = await this.prompt([
			this._label("deployInfo", () =>
				defaults.source ? `Defaults taken from ${defaults.source}` : "No deploy configuration found - ui5-deploy-btp.yaml is created from ui5.yaml"),
			{
				type: "input",
				name: "abapApp",
				message: "BSP application name",
				default: defaults.app,
				guiOptions: { mandatory: true, hint: "Name of the app in the ABAP repository, max. 15 characters (namespace included, e.g. /ABC/APP)" },
				validate: (v) => (/^(\/[A-Z0-9_]+\/)?[A-Z0-9_]+$/i.test(v || "") && v.length <= 15 ? true : "Up to 15 characters: letters, digits, _ and an optional /NAMESPACE/"),
				filter: (v) => (v || "").trim().toUpperCase()
			},
			{
				type: "input",
				name: "abapPackage",
				message: "Package",
				default: defaults.package,
				guiOptions: { mandatory: true },
				validate: required("Package"),
				filter: (v) => (v || "").trim().toUpperCase()
			},
			{
				type: "input",
				name: "abapTransport",
				message: "Transport request",
				// an empty answer falls back to the default in the CLI - none for a local package
				default: (a) => (/^\$/.test(a.abapPackage || "") ? undefined : defaults.transport),
				guiOptions: { hint: "Leave empty for a local package ($TMP / $...)" },
				validate: (v, a) => (v || /^\$/.test(a.abapPackage || "") ? true : "A transport request is required for a non-local package"),
				filter: (v) => (v || "").trim().toUpperCase()
			},
			{
				type: "input",
				name: "abapClient",
				message: "Client",
				default: this.deployDest["sap-client"] || defaults.client,
				guiOptions: { hint: "sap-client sent with the upload; empty = the destination's / system's default" },
				validate: (v) => (!v || /^\d{3}$/.test(v) ? true : "Three digits, e.g. 100")
			},
			{
				type: "input",
				name: "deployUser",
				message: `ABAP user for ${this.deployDest.Name}`,
				default: prev.USR,
				when: () => this.needsCredentials,
				guiOptions: { mandatory: true, hint: "Written to .env (USR), used by fiori deploy through env:USR" },
				validate: required("User")
			},
			{
				type: "password",
				name: "deployPassword",
				message: "Password",
				default: prev.SAP_PWD,
				when: () => this.needsCredentials,
				guiOptions: { mandatory: true, hint: "Written to .env (SAP_PWD) - .env is added to .gitignore" },
				validate: required("Password")
			}
		]);
		// filters do not run in every prompt implementation
		for (const key of ["abapApp", "abapPackage", "abapTransport"]) answers[key] = (answers[key] || "").trim().toUpperCase();
		Object.assign(this.answers, answers);
	}

	async prompting() {
		await this._promptProject();
		if (this.cfSession === OTHER_SESSION && !this.prompts.items.includes(STEPS.login)) {
			this.prompts.splice(this.prompts.items.indexOf(STEPS.project) + 1, 0, [STEPS.endpoint, STEPS.login]);
		}
		if (!this.cfStatus.loggedIn || this.cfSession === OTHER_SESSION) await this._promptLogin();
		await this._promptTarget();
		await this._promptDestinations();
		if (this.setupDeploy) await this._promptDeploy();
	}

	/* ---------- writing ---------- */

	// files we own are written without an overwrite prompt
	_put(file, contents) {
		const target = path.join(this.project.root, file);
		this.fs.write(target, contents);
		this.fs.store.get(target).conflicter = "force";
	}

	_remove(file) {
		const target = path.join(this.project.root, file);
		if (this.fs.exists(target)) this.fs.delete(target);
	}

	/**
	 * Proxy / tunnel ports of this environment: its own ones when no other environment uses them, else the first
	 * free set (5050 / 20003 + 5051 / 20004, then +2 each) - so several environments can run side by side.
	 */
	_ports() {
		const used = new Set();
		for (const other of project.profiles(this.project.root).filter((p) => p !== this.profile)) {
			const env = project.parseEnv(project.read(path.join(this.project.root, `.env.${other}`)));
			for (const key of PORT_KEYS) if (env[key]) used.add(Number(env[key]));
		}
		const prev = this.existingEnv;
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

	writing() {
		const root = this.project.root;
		const a = this.answers;
		const p = this.profile;
		const scripts = { start: `start-btp:${p}`, deploy: `deploy-btp:${p}`, deployTest: `deploy-btp-test:${p}`, proxy: `btp-proxy:${p}` };
		const sameDestination = a.runtimeDestination === a.deployDestination;
		const ports = this._ports();
		const deployPorts = sameDestination ? ports.runtime : ports.deploy;

		for (const script of ["btp-env.js", "btp-proxy.js", "btp.js"]) {
			this._put(path.join("scripts", script), this.fs.read(this.templatePath("scripts", script)));
		}

		this._put(`ui5-btp-${p}.yaml`, project.runtimeYaml(this.fs.read(path.join(root, "ui5.yaml")), {
			port: ports.runtime.proxy,
			destination: a.runtimeDestination,
			script: scripts.start
		}));
		if (this.setupDeploy) {
			this._put(`ui5-deploy-btp-${p}.yaml`, project.deployYaml(root, {
				port: deployPorts.proxy,
				destination: a.deployDestination,
				client: a.abapClient,
				app: a.abapApp,
				pkg: a.abapPackage,
				transport: a.abapTransport,
				credentials: this.needsCredentials,
				script: scripts.deploy
			}));
		} else {
			this._remove(`ui5-deploy-btp-${p}.yaml`);
		}

		// undefined removes the key - the BTP_DEPLOY_* keys go when there is no deployment
		const envValues = {
			BTP_CF_API: this.cfStatus.api,
			BTP_CF_ORG: a.org,
			BTP_CF_SPACE: a.space,
			BTP_CF_SSO: this.loginSso === undefined ? this.existingEnv.BTP_CF_SSO : this.loginSso ? "true" : undefined,
			BTP_APP: a.app,
			BTP_DESTINATION: a.runtimeDestination,
			BTP_PROXY_PORT: ports.runtime.proxy,
			BTP_TUNNEL_PORT: ports.runtime.tunnel,
			BTP_DEPLOY_DESTINATION: a.deployDestination,
			BTP_DEPLOY_PROXY_PORT: this.setupDeploy && !sameDestination ? deployPorts.proxy : undefined,
			BTP_DEPLOY_TUNNEL_PORT: this.setupDeploy && !sameDestination ? deployPorts.tunnel : undefined
		};
		if (this.needsCredentials) Object.assign(envValues, { USR: a.deployUser, SAP_PWD: a.deployPassword });
		const envFile = `.env.${p}`;
		this._put(envFile, project.mergeEnv(project.read(path.join(root, envFile)), envValues, `${ENV_HEADER} - environment '${p}'`));

		// a project set up before environments existed: its settings moved to .env.<name>, the old files and scripts go
		if (this.migrateLegacy) {
			const legacyKeys = Object.fromEntries([...LEGACY_ENV_KEYS, ...(this.needsCredentials ? ["USR", "SAP_PWD"] : [])].map((k) => [k, undefined]));
			this._put(".env", project.mergeEnv(project.read(path.join(root, ".env")), legacyKeys));
			this._remove("ui5-btp.yaml");
			this._remove("ui5-deploy-btp.yaml");
		}

		const launch = project.launchJson(project.read(path.join(root, ".vscode", "launch.json")), p, { dropLegacy: this.migrateLegacy });
		if (launch && launch.error) this.log(`${launch.error} - add a run configuration for 'npm run ${scripts.start}' yourself`);
		else if (launch) this._put(path.join(".vscode", "launch.json"), launch.text);

		let gitignore = project.read(path.join(root, ".gitignore"));
		for (const entry of [".env", envFile]) gitignore = project.ensureGitignore(gitignore, entry) ?? gitignore;
		if (gitignore !== project.read(path.join(root, ".gitignore"))) this._put(".gitignore", gitignore);

		const pkgText = this.fs.read(path.join(root, "package.json"));
		const pkg = JSON.parse(pkgText);
		pkg.scripts = { ...pkg.scripts };
		if (this.migrateLegacy) for (const name of ["btp-proxy", "start-btp", "deploy-btp", "deploy-btp-test"]) delete pkg.scripts[name];
		Object.assign(pkg.scripts, {
			[scripts.proxy]: `node scripts/btp-proxy.js --profile ${p}`,
			[scripts.start]: `node scripts/btp.js start ${p}`
		});
		if (this.setupDeploy) {
			Object.assign(pkg.scripts, { [scripts.deploy]: `node scripts/btp.js deploy ${p}`, [scripts.deployTest]: `node scripts/btp.js deploy ${p} --test` });
		} else {
			delete pkg.scripts[scripts.deploy];
			delete pkg.scripts[scripts.deployTest];
		}
		const indent = (/^\{\r?\n([ \t]+)"/.exec(pkgText) || [])[1] || "  ";
		this._put("package.json", JSON.stringify(pkg, null, indent) + "\n");
		this.scripts = scripts;
	}

	async end() {
		const a = this.answers;
		const s = this.scripts;
		try {
			await cf.target(a.org, a.space);
			this.log(`cf now targets ${a.org}/${a.space}`);
		} catch (e) {
			this.log(`Could not run 'cf target -o "${a.org}" -s "${a.space}"': ${e.message}`);
		}
		const pad = (name) => `  npm run ${name}`.padEnd(36);
		this.log("");
		this.log(`BTP destination scripts for environment '${this.profile}' added to ${this.project.root}`);
		this.log(`${pad(s.start)}run the app through ${a.runtimeDestination}`);
		if (this.setupDeploy) {
			this.log(`${pad(s.deploy)}build + deploy through ${a.deployDestination}`);
			this.log(`${pad(s.deployTest)}same, test mode`);
		}
		this.log(`${pad(s.proxy)}only the proxy (runtime destination)`);
		this.log(`The scripts point cf at ${this.cfStatus.api} ${a.org}/${a.space} themselves (cf login in the terminal when needed).`);
	}
};
