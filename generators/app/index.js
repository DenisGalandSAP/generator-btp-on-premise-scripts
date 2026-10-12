"use strict";
/*
 * Adds scripts/btp-proxy.js + scripts/btp.js to a SAPUI5 / SAP Fiori elements project so it can run and
 * deploy through on-premise BTP destinations (cf ssh tunnel to the connectivity proxy of a CF app).
 *
 * Steps: project -> Cloud Foundry endpoint + login (only when needed) -> org / space / app -> runtime + deploy
 * destination -> deploy target and credentials (when the deploy destination has no authentication).
 */
const Generator = require("yeoman-generator");
const path = require("path");
const { Prompts } = require("@sap-devx/yeoman-ui-types");
const project = require("./lib/project");
const cf = require("./lib/cf");
const regions = require("./lib/regions");

const STEPS = {
	project: { name: "Project", description: "SAPUI5 or SAP Fiori elements project to add the BTP destination scripts to" },
	endpoint: { name: "Cloud Foundry Endpoint", description: "You are not logged in to Cloud Foundry (or the session expired) - select the region of the subaccount" },
	login: { name: "Cloud Foundry Login", description: "Log on to the Cloud Foundry environment of the subaccount" },
	target: { name: "Cloud Foundry Target", description: "Org, space and the app bound to the destination and connectivity services" },
	destinations: { name: "Destinations", description: "Destination used to run the app and destination used to deploy it" },
	deploy: { name: "Deployment", description: "ABAP repository target and logon for the deploy destination" }
};

const OTHER_ENDPOINT = "other";

const SUPPORTED_AUTH = ["NoAuthentication", "BasicAuthentication"];
const RUNTIME_PORTS = { proxy: 5050, tunnel: 20003 };
const DEPLOY_PORTS = { proxy: 5051, tunnel: 20004 };
const ENV_HEADER = "SAP BTP on-premise access (@scodigis/generator-btp-on-premise-scripts)";

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
		const answers = await this.prompt([
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
				return notes.join(" - ");
			})
		]);
		this.project = project.inspect(answers.projectPath);
		this.existingEnv = project.parseEnv(project.read(path.join(this.project.root, ".env")));
		if (!this.isGui) this.log(`${this.project.kind} app '${this.project.id}'`);
	}

	/* ---------- 2. login ---------- */

	// SAP BTP Cloud Foundry regions, as offered by the Cloud Connector when adding a subaccount
	async _endpointChoices() {
		if (!this.regions) this.regions = await regions.list();
		const current = (this.cfStatus.api || "").replace(/\/+$/, "");
		const choices = this.regions.regions.map((r) => ({ name: `${r.key}  -  ${r.location} - ${r.provider}  (${r.api})`, value: r.api }));
		if (current && !choices.some((c) => c.value === current)) choices.unshift({ name: `${current}  (current cf target)`, value: current });
		choices.push({ name: "Other - enter the API endpoint", value: OTHER_ENDPOINT });
		return choices;
	}

	async _promptLogin() {
		const endpoint = await this.prompt([
			this._label("loginInfo", () =>
				this.cfStatus.api
					? `The Cloud Foundry session for ${this.cfStatus.api} is not valid anymore${this.cfStatus.error ? ` (${this.cfStatus.error})` : ""}.`
					: "The cf CLI has no API endpoint yet."),
			{
				type: "list",
				name: "cfRegion",
				message: "Region (API endpoint)",
				choices: () => this._endpointChoices(),
				default: (this.cfStatus.api || "").replace(/\/+$/, "") || "https://api.cf.eu10.hana.ondemand.com",
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
			if (loggedInWith === key && this.cfStatus.loggedIn) return true;
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
		if (!this.cfStatus.loggedIn) await this._check(loginWith(credentials));
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
		if (!apps.length) return `No app in ${a.org}/${a.space} is bound to both a destination and a connectivity service instance`;
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
				guiOptions: {
					mandatory: true,
					hint: "The local proxy reads the service keys from this app's environment and opens 'cf ssh' through it to the connectivity proxy"
				},
				validate: (name, a) => this._validateApp(name, a)
			}
		]);
		// the yo CLI does not validate list answers
		await this._check(this._validateApp(answers.app, answers));
		Object.assign(this.answers, answers);
		this.app = (await this._apps(answers.org, answers.space)).find((x) => x.name === answers.app);
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
		const deployDest = project.deployDefaults(this.project.root).destination;
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
				type: "list",
				name: "deployDestination",
				message: "Deploy destination (npm run deploy-btp)",
				choices: () => this._destinationChoices(),
				default: (a) => this._knownDestination(prev.BTP_DEPLOY_DESTINATION, deployDest, a.runtimeDestination),
				guiOptions: { mandatory: true, hint: "The ABAP repository upload (/sap/opu/odata/UI5/ABAP_REPOSITORY_SRV) goes through this destination" },
				validate: validateDestination
			},
			this._label("deployAuthInfo", (a) => describe(a.deployDestination, "Deploy"))
		]);
		await this._check(validateDestination(answers.runtimeDestination));
		await this._check(validateDestination(answers.deployDestination));
		Object.assign(this.answers, answers);
		this.runtimeDest = await this._destination(answers.runtimeDestination);
		this.deployDest = await this._destination(answers.deployDestination);
	}

	/* ---------- 5. deploy ---------- */

	async _promptDeploy() {
		const prev = this.existingEnv;
		const defaults = project.deployDefaults(this.project.root);
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
		if (!this.cfStatus.loggedIn) await this._promptLogin();
		await this._promptTarget();
		await this._promptDestinations();
		await this._promptDeploy();
	}

	/* ---------- writing ---------- */

	// files we own are written without an overwrite prompt
	_put(file, contents) {
		const target = path.join(this.project.root, file);
		this.fs.write(target, contents);
		this.fs.store.get(target).conflicter = "force";
	}

	writing() {
		const root = this.project.root;
		const a = this.answers;
		const sameDestination = a.runtimeDestination === a.deployDestination;
		const deployPorts = sameDestination
			? { proxy: Number(this.existingEnv.BTP_PROXY_PORT || RUNTIME_PORTS.proxy), tunnel: Number(this.existingEnv.BTP_TUNNEL_PORT || RUNTIME_PORTS.tunnel) }
			: { proxy: Number(this.existingEnv.BTP_DEPLOY_PROXY_PORT || DEPLOY_PORTS.proxy), tunnel: Number(this.existingEnv.BTP_DEPLOY_TUNNEL_PORT || DEPLOY_PORTS.tunnel) };
		const runtimePort = Number(this.existingEnv.BTP_PROXY_PORT || RUNTIME_PORTS.proxy);

		for (const script of ["btp-proxy.js", "btp.js"]) {
			this._put(path.join("scripts", script), this.fs.read(this.templatePath("scripts", script)));
		}

		this._put("ui5-btp.yaml", project.runtimeYaml(this.fs.read(path.join(root, "ui5.yaml")), { port: runtimePort, destination: a.runtimeDestination }));
		this._put("ui5-deploy-btp.yaml", project.deployYaml(root, {
			port: deployPorts.proxy,
			destination: a.deployDestination,
			client: a.abapClient,
			app: a.abapApp,
			pkg: a.abapPackage,
			transport: a.abapTransport,
			credentials: this.needsCredentials
		}));

		const envValues = {
			BTP_APP: a.app,
			BTP_CF_ORG: a.org,
			BTP_CF_SPACE: a.space,
			BTP_DESTINATION: a.runtimeDestination,
			BTP_PROXY_PORT: runtimePort,
			BTP_TUNNEL_PORT: this.existingEnv.BTP_TUNNEL_PORT || RUNTIME_PORTS.tunnel,
			BTP_DEPLOY_DESTINATION: a.deployDestination,
			BTP_DEPLOY_PROXY_PORT: sameDestination ? undefined : deployPorts.proxy,
			BTP_DEPLOY_TUNNEL_PORT: sameDestination ? undefined : deployPorts.tunnel
		};
		if (this.needsCredentials) Object.assign(envValues, { USR: a.deployUser, SAP_PWD: a.deployPassword });
		this._put(".env", project.mergeEnv(project.read(path.join(root, ".env")), envValues, ENV_HEADER));

		const launch = project.launchJson(project.read(path.join(root, ".vscode", "launch.json")));
		if (launch && launch.error) this.log(`${launch.error} - add a run configuration for 'npm run start-btp' yourself`);
		else if (launch) this._put(path.join(".vscode", "launch.json"), launch.text);

		const gitignore = project.ensureGitignore(project.read(path.join(root, ".gitignore")), ".env");
		if (gitignore !== undefined) this._put(".gitignore", gitignore);

		const pkg = JSON.parse(this.fs.read(path.join(root, "package.json")));
		pkg.scripts = {
			...pkg.scripts,
			"btp-proxy": "node scripts/btp-proxy.js",
			"start-btp": "node scripts/btp.js start",
			"deploy-btp": "node scripts/btp.js deploy",
			"deploy-btp-test": "node scripts/btp.js deploy --test"
		};
		const indent = (/^\{\r?\n([ \t]+)"/.exec(this.fs.read(path.join(root, "package.json"))) || [])[1] || "  ";
		this._put("package.json", JSON.stringify(pkg, null, indent) + "\n");
	}

	async end() {
		const a = this.answers;
		try {
			await cf.target(a.org, a.space);
			this.log(`cf now targets ${a.org}/${a.space}`);
		} catch (e) {
			this.log(`Could not run 'cf target -o "${a.org}" -s "${a.space}"': ${e.message}`);
		}
		this.log("");
		this.log(`BTP destination scripts added to ${this.project.root}`);
		this.log(`  npm run start-btp        run the app through ${a.runtimeDestination}`);
		this.log(`  npm run deploy-btp       build + deploy through ${a.deployDestination}`);
		this.log("  npm run deploy-btp-test  same, test mode");
		this.log("  npm run btp-proxy        only the proxy (runtime destination)");
	}
};
