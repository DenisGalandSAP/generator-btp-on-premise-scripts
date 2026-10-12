"use strict";
/*
 * Project inspection and file transformations (ui5*.yaml, .env, package.json, .gitignore).
 */
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

const read = (file) => {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (e) {
		return undefined;
	}
};

/** First YAML document of a ui5*.yaml (later documents are project shims / extensions). */
function parseUi5Yaml(text) {
	return YAML.parseAllDocuments(text)[0];
}

/** Checks that the folder holds a SAPUI5 freestyle or SAP Fiori elements application. */
function inspect(projectPath) {
	if (!projectPath) return { error: "Select the project folder" };
	const root = path.resolve(projectPath);
	if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { error: `Folder not found: ${root}` };

	const pkgText = read(path.join(root, "package.json"));
	if (!pkgText) return { error: "No package.json in this folder - select the root folder of a SAPUI5 / SAP Fiori elements project" };
	const ui5Text = read(path.join(root, "ui5.yaml"));
	if (!ui5Text) return { error: "No ui5.yaml in this folder - select the root folder of a SAPUI5 / SAP Fiori elements project" };

	let pkg, ui5;
	try {
		pkg = JSON.parse(pkgText);
	} catch (e) {
		return { error: `package.json is not valid JSON: ${e.message}` };
	}
	try {
		ui5 = parseUi5Yaml(ui5Text).toJS();
	} catch (e) {
		return { error: `ui5.yaml is not valid YAML: ${e.message}` };
	}
	if (!ui5 || ui5.type !== "application") return { error: `ui5.yaml declares type '${ui5 && ui5.type}', expected 'application'` };

	const webapp = (ui5.resources && ui5.resources.configuration && ui5.resources.configuration.paths && ui5.resources.configuration.paths.webapp) || "webapp";
	const manifestText = read(path.join(root, webapp, "manifest.json"));
	if (!manifestText) return { error: `No ${webapp}/manifest.json - this is not a SAPUI5 application` };
	let manifest;
	try {
		manifest = JSON.parse(manifestText);
	} catch (e) {
		return { error: `${webapp}/manifest.json is not valid JSON: ${e.message}` };
	}
	const app = manifest["sap.app"] || {};
	if (app.type && app.type !== "application") return { error: `manifest.json sap.app/type is '${app.type}', expected 'application'` };

	const libs = Object.keys((manifest["sap.ui5"] && manifest["sap.ui5"].dependencies && manifest["sap.ui5"].dependencies.libs) || {});
	const kind = libs.includes("sap.fe.templates")
		? "SAP Fiori elements (OData V4)"
		: libs.includes("sap.suite.ui.generic.template")
			? "SAP Fiori elements (OData V2)"
			: "SAPUI5 freestyle";

	return {
		root,
		id: app.id || (ui5.metadata && ui5.metadata.name),
		kind,
		webapp,
		pkg,
		hasBuildScript: !!(pkg.scripts && pkg.scripts.build),
		hasProxyMiddleware: JSON.stringify(ui5.server || {}).includes("fiori-tools-proxy")
	};
}

/** Folders to offer as default: the workspace folders and their direct children that are UI5 apps. */
function findProjects(folders) {
	const found = [];
	for (const folder of folders) {
		if (inspect(folder).root) found.push(folder);
		let entries = [];
		try {
			entries = fs.readdirSync(folder, { withFileTypes: true });
		} catch (e) {
			/* unreadable */
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const child = path.join(folder, entry.name);
			if (inspect(child).root) found.push(child);
		}
	}
	return found;
}

/* ---------- .env ---------- */

/** Environments set up in a project: names of the .env.<name> files that hold BTP_APP, sorted. */
function profiles(root) {
	let files = [];
	try {
		files = fs.readdirSync(root);
	} catch (e) {
		return [];
	}
	return files
		.filter((f) => /^\.env\.[\w-]+$/.test(f) && parseEnv(read(path.join(root, f))).BTP_APP)
		.map((f) => f.slice(".env.".length))
		.sort();
}

function parseEnv(text) {
	const values = {};
	for (const line of (text || "").split(/\r?\n/)) {
		const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line);
		if (!m) continue;
		let value = m[2].trim();
		const q = value[0];
		if ((q === '"' || q === "'" || q === "`") && value.endsWith(q) && value.length > 1) value = value.slice(1, -1);
		else value = value.replace(/\s+#.*$/, "");
		values[m[1]] = value;
	}
	return values;
}

function quoteEnv(value) {
	value = String(value);
	if (/^[\w\-.:/@+,]*$/.test(value)) return value;
	if (!value.includes("'")) return `'${value}'`;
	if (!value.includes('"')) return `"${value}"`;
	return `\`${value}\``;
}

/**
 * Sets the given keys in a .env text: existing lines are updated in place, missing keys are appended
 * under a header. `undefined` values remove the key. Everything else is left untouched.
 */
function mergeEnv(text, values, header) {
	const lines = text ? text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n") : [];
	const pending = new Map(Object.entries(values));
	const out = [];
	for (const line of lines) {
		const m = /^\s*(?:export\s+)?([\w.-]+)\s*=/.exec(line);
		if (m && pending.has(m[1])) {
			const value = pending.get(m[1]);
			pending.delete(m[1]);
			if (value !== undefined) out.push(`${m[1]}=${quoteEnv(value)}`);
			continue;
		}
		out.push(line);
	}
	const added = [...pending].filter(([, v]) => v !== undefined);
	if (added.length) {
		if (out.length && out[out.length - 1] !== "") out.push("");
		if (header) out.push(`# ${header}`);
		for (const [key, value] of added) out.push(`${key}=${quoteEnv(value)}`);
	}
	return out.join("\n") + "\n";
}

/* ---------- ui5 yaml ---------- */

const BACKEND_KEYS_TO_DROP = ["destination", "destinationInstance", "client", "scp", "authenticationType", "connectionType", "apiHub"];

/** ui5-btp.yaml: ui5.yaml with every fiori-tools-proxy backend pointing at the local btp-proxy. */
function runtimeYaml(ui5Text, { port, destination, script = "start-btp" }) {
	const doc = parseUi5Yaml(ui5Text);
	const url = () => {
		const node = doc.createNode(`http://127.0.0.1:${port}`);
		node.comment = ` scripts/btp-proxy.js -> BTP destination ${destination} (npm run ${script})`;
		return node;
	};
	let middlewares = doc.getIn(["server", "customMiddleware"]);
	if (!middlewares) {
		doc.setIn(["server", "customMiddleware"], doc.createNode([]));
		middlewares = doc.getIn(["server", "customMiddleware"]);
	}
	let proxy = middlewares.items.find((m) => YAML.isMap(m) && m.get("name") === "fiori-tools-proxy");
	if (!proxy) {
		proxy = doc.createNode({ name: "fiori-tools-proxy", afterMiddleware: "compression", configuration: {} });
		middlewares.items.unshift(proxy);
	}
	let backends = proxy.getIn(["configuration", "backend"]);
	if (!YAML.isSeq(backends) || !backends.items.length) {
		proxy.setIn(["configuration", "backend"], doc.createNode([{ path: "/sap" }]));
		backends = proxy.getIn(["configuration", "backend"]);
	}
	for (const backend of backends.items) {
		if (!YAML.isMap(backend)) continue;
		for (const key of BACKEND_KEYS_TO_DROP) backend.delete(key);
		backend.set("url", url());
	}
	return doc.toString({ lineWidth: 0 });
}

const DEPLOY_TASK = "deploy-to-abap";

function findDeployTask(doc) {
	const tasks = doc.getIn(["builder", "customTasks"]);
	return YAML.isSeq(tasks) ? tasks.items.find((t) => YAML.isMap(t) && t.get("name") === DEPLOY_TASK) : undefined;
}

/**
 * App name / package / transport / client / destination of an existing deploy configuration, if any.
 * The environment's own ui5-deploy-btp-<profile>.yaml wins, then the one of a project set up before
 * environments existed, then those of the other environments (same app and package), then ui5-deploy.yaml.
 * The ui5-deploy-btp*.yaml target the local proxy, so the BTP destination comes from ui5-deploy.yaml.
 */
function deployDefaults(root, profile) {
	const result = {};
	let others = [];
	try {
		others = fs.readdirSync(root).filter((f) => /^ui5-deploy-btp-[\w-]+\.yaml$/.test(f)).sort();
	} catch (e) {
		/* no folder */
	}
	const files = [...new Set([...(profile ? [`ui5-deploy-btp-${profile}.yaml`] : []), "ui5-deploy-btp.yaml", ...others, "ui5-deploy.yaml"])];
	for (const file of files) {
		const text = read(path.join(root, file));
		if (!text) continue;
		try {
			const doc = parseUi5Yaml(text);
			const task = findDeployTask(doc);
			if (!task || !YAML.isMap(task.get("configuration"))) continue;
			const cfg = task.get("configuration").toJS(doc); // yaml v2: a node needs its document
			const app = cfg.app || {};
			const target = cfg.target || {};
			if (!result.source) {
				Object.assign(result, {
					source: file,
					app: app.name,
					package: app.package,
					transport: app.transport,
					client: target.client !== undefined && target.client !== null ? String(target.client) : undefined
				});
			}
			if (!result.destination && target.destination) result.destination = String(target.destination);
		} catch (e) {
			/* ignore unreadable file */
		}
	}
	return result;
}

/** Destinations of the fiori-tools-proxy backends in ui5.yaml. */
function runtimeDestinations(root) {
	try {
		const ui5 = parseUi5Yaml(read(path.join(root, "ui5.yaml")) || "").toJS() || {};
		const middlewares = (ui5.server && ui5.server.customMiddleware) || [];
		const proxy = middlewares.find((m) => m && m.name === "fiori-tools-proxy");
		const backends = (proxy && proxy.configuration && proxy.configuration.backend) || [];
		return (Array.isArray(backends) ? backends : [backends]).map((b) => b && b.destination).filter(Boolean).map(String);
	} catch (e) {
		return [];
	}
}

/**
 * ui5-deploy-btp.yaml: based on ui5-deploy.yaml when there is one (keeps its custom tasks), otherwise
 * on ui5.yaml without the server part. The deploy-to-abap target is the local btp-proxy.
 */
function deployYaml(root, { port, destination, client, app, pkg, transport, credentials, script = "deploy-btp" }) {
	const deployText = read(path.join(root, "ui5-deploy.yaml"));
	const doc = parseUi5Yaml(deployText || read(path.join(root, "ui5.yaml")));
	if (!deployText) doc.delete("server");

	const target = doc.createNode({ url: `http://127.0.0.1:${port}`, ...(client ? { client: String(client) } : {}) });
	target.get("url", true).comment = ` scripts/btp-proxy.js -> BTP destination ${destination} (npm run ${script})`;
	const appNode = { name: app, package: pkg, ...(transport ? { transport } : {}) };

	let task = findDeployTask(doc);
	if (!task) {
		if (!YAML.isSeq(doc.getIn(["builder", "customTasks"]))) doc.setIn(["builder", "customTasks"], doc.createNode([]));
		task = doc.createNode({ name: DEPLOY_TASK, afterTask: "generateCachebusterInfo", configuration: {} });
		doc.getIn(["builder", "customTasks"]).items.push(task);
	}
	if (!YAML.isMap(task.get("configuration"))) task.set("configuration", doc.createNode({}));
	const cfg = task.get("configuration");
	cfg.set("target", target);
	if (credentials) cfg.set("credentials", doc.createNode({ username: "env:USR", password: "env:SAP_PWD" }));
	else cfg.delete("credentials");
	cfg.set("app", doc.createNode(appNode));
	if (!cfg.has("exclude")) cfg.set("exclude", doc.createNode(["/test/"]));

	if (!doc.hasIn(["builder", "resources", "excludes"])) doc.setIn(["builder", "resources", "excludes"], doc.createNode(["/test/**", "/localService/**"]));
	return doc.toString({ lineWidth: 0 });
}

/* ---------- .vscode/launch.json ---------- */

const LEGACY_LAUNCH = { name: "Run with BTP destination (cf ssh)", command: "npm run start-btp" };
const launchConfig = (profile) => ({
	name: `Run with BTP destination (${profile})`,
	type: "node-terminal",
	request: "launch",
	command: `npm run start-btp:${profile}`,
	cwd: "${workspaceFolder}"
});

// launch.json may contain comments and trailing commas (JSONC)
function parseJsonc(text) {
	const stripped = text
		.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || "")
		.replace(/,(\s*[}\]])/g, "$1");
	return JSON.parse(stripped);
}

/**
 * launch.json with the start-btp:<profile> configuration added (dropLegacy: without the one of a project set up
 * before environments existed). Returns undefined when there is nothing to change, or { error } when the existing
 * file cannot be read (it is then left untouched).
 */
function launchJson(text, profile, { dropLegacy = false } = {}) {
	const config = launchConfig(profile);
	let launch = { version: "0.2.0", configurations: [] };
	if (text && text.trim()) {
		try {
			launch = parseJsonc(text);
		} catch (e) {
			return { error: `.vscode/launch.json could not be parsed (${e.message})` };
		}
	}
	if (!Array.isArray(launch.configurations)) launch.configurations = [];
	const before = launch.configurations.length;
	if (dropLegacy) launch.configurations = launch.configurations.filter((c) => !(c && c.name === LEGACY_LAUNCH.name && c.command === LEGACY_LAUNCH.command));
	const present = launch.configurations.some((c) => c && (c.name === config.name || c.command === config.command));
	if (present && launch.configurations.length === before) return undefined;
	if (!present) launch.configurations.unshift(config);
	return { text: JSON.stringify(launch, null, 4) + "\n" };
}

/* ---------- misc ---------- */

function ensureGitignore(text, entry) {
	const lines = (text || "").split(/\r?\n/).map((l) => l.trim());
	if (lines.includes(entry) || lines.includes(`/${entry}`)) return undefined;
	return (text && !text.endsWith("\n") ? text + "\n" : text || "") + entry + "\n";
}

module.exports = { inspect, findProjects, profiles, parseEnv, mergeEnv, runtimeYaml, deployYaml, deployDefaults, runtimeDestinations, launchJson, ensureGitignore, read };
