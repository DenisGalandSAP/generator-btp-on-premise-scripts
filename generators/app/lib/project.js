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
function runtimeYaml(ui5Text, { port, destination }) {
	const doc = parseUi5Yaml(ui5Text);
	const url = () => {
		const node = doc.createNode(`http://localhost:${port}`);
		node.comment = ` scripts/btp-proxy.js -> BTP destination ${destination} (npm run start-btp)`;
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

/** App name / package / transport / client of an existing deploy configuration, if any. */
function deployDefaults(root) {
	for (const file of ["ui5-deploy-btp.yaml", "ui5-deploy.yaml"]) {
		const text = read(path.join(root, file));
		if (!text) continue;
		try {
			const task = findDeployTask(parseUi5Yaml(text));
			if (!task) continue;
			const cfg = task.get("configuration").toJS();
			return {
				source: file,
				app: cfg.app && cfg.app.name,
				package: cfg.app && cfg.app.package,
				transport: cfg.app && cfg.app.transport,
				client: cfg.target && cfg.target.client !== undefined ? String(cfg.target.client) : undefined
			};
		} catch (e) {
			/* ignore unreadable file */
		}
	}
	return {};
}

/**
 * ui5-deploy-btp.yaml: based on ui5-deploy.yaml when there is one (keeps its custom tasks), otherwise
 * on ui5.yaml without the server part. The deploy-to-abap target is the local btp-proxy.
 */
function deployYaml(root, { port, destination, client, app, pkg, transport, credentials }) {
	const deployText = read(path.join(root, "ui5-deploy.yaml"));
	const doc = parseUi5Yaml(deployText || read(path.join(root, "ui5.yaml")));
	if (!deployText) doc.delete("server");

	const target = doc.createNode({ url: `http://localhost:${port}`, ...(client ? { client: String(client) } : {}) });
	target.get("url", true).comment = ` scripts/btp-proxy.js -> BTP destination ${destination} (npm run deploy-btp)`;
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

/* ---------- misc ---------- */

function ensureGitignore(text, entry) {
	const lines = (text || "").split(/\r?\n/).map((l) => l.trim());
	if (lines.includes(entry) || lines.includes(`/${entry}`)) return undefined;
	return (text && !text.endsWith("\n") ? text + "\n" : text || "") + entry + "\n";
}

module.exports = { inspect, findProjects, parseEnv, mergeEnv, runtimeYaml, deployYaml, deployDefaults, ensureGitignore, read };
