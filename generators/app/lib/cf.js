"use strict";
/*
 * Cloud Foundry CLI / API helpers used by the generator.
 * Everything goes through the cf CLI (no shell, so arguments are never re-parsed).
 */
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CF_ENV = { ...process.env, MSYS_NO_PATHCONV: "1", CF_COLOR: "false" };

function cf(args, { env, input, timeout = 60000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn("cf", args, { env: { ...CF_ENV, ...env }, windowsHide: true });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill(), timeout);
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err.code === "ENOENT" ? new Error("The cf CLI was not found in PATH - install it from https://github.com/cloudfoundry/cli") : err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) return resolve(stdout.trim());
			const output = `${stdout}\n${stderr}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== "FAILED");
			reject(new Error(output.slice(-3).join(" ") || `cf ${args[0]} failed (${code})`));
		});
		child.stdin.end(input || "");
	});
}

// `cf curl` exits 0 on API errors too - turn those into exceptions
async function curl(apiPath) {
	const json = JSON.parse(await cf(["curl", apiPath]));
	if (json.errors && json.errors.length) throw new Error(json.errors.map((e) => e.detail || e.title).join("; "));
	return json;
}

async function curlAll(apiPath) {
	const resources = [];
	const included = {};
	let next = apiPath;
	while (next) {
		const page = await curl(next);
		resources.push(...(page.resources || []));
		for (const [key, list] of Object.entries(page.included || {})) included[key] = (included[key] || []).concat(list);
		const href = page.pagination && page.pagination.next && page.pagination.next.href;
		next = href ? href.replace(/^https?:\/\/[^/]+/, "") : undefined;
	}
	return { resources, included };
}

function readConfig() {
	const home = process.env.CF_HOME || os.homedir();
	try {
		return JSON.parse(fs.readFileSync(path.join(home, ".cf", "config.json"), "utf8"));
	} catch (e) {
		return {};
	}
}

/**
 * `cf target` keeps answering after the token has expired, so check with a call that needs a valid
 * (or refreshable) token.
 */
async function loginStatus() {
	const config = readConfig();
	const status = {
		api: config.Target || "",
		org: (config.OrganizationFields && config.OrganizationFields.Name) || "",
		space: (config.SpaceFields && config.SpaceFields.Name) || "",
		loggedIn: false
	};
	if (!status.api) return status;
	try {
		await cf(["oauth-token"], { timeout: 30000 });
		status.loggedIn = true;
		const target = await cf(["target"]);
		const user = /^user:\s*(.+)$/m.exec(target);
		status.user = user ? user[1].trim() : "";
	} catch (e) {
		status.error = e.message;
	}
	return status;
}

/** Login page URL of an API endpoint (where the SSO passcode is shown). */
async function loginUrl(api) {
	try {
		const res = await fetch(api.replace(/\/+$/, "") + "/", { signal: AbortSignal.timeout(10000) });
		const json = await res.json();
		const href = json.links && json.links.login && json.links.login.href;
		if (href) return href;
	} catch (e) {
		/* fall back to the usual naming */
	}
	return api.replace("://api.", "://login.");
}

async function loginWithPasscode(api, passcode) {
	// an empty line answers "Select an org (or press enter to skip)" when there are several orgs
	await cf(["login", "-a", api, "--sso-passcode", passcode], { input: "\n\n\n" });
}

async function loginWithPassword(api, user, password, origin) {
	await cf(["api", api]);
	// cf auth reads the credentials from the environment, so they never show up in a process list
	const args = ["auth"];
	if (origin) args.push("--origin", origin);
	await cf(args, { env: { CF_USERNAME: user, CF_PASSWORD: password } });
}

async function orgs() {
	const { resources } = await curlAll("/v3/organizations?per_page=200&order_by=name");
	return resources.map((o) => ({ name: o.name, guid: o.guid }));
}

async function spaces(orgGuid) {
	const { resources } = await curlAll(`/v3/spaces?organization_guids=${orgGuid}&per_page=200&order_by=name`);
	return resources.map((s) => ({ name: s.name, guid: s.guid }));
}

/** Destination and connectivity service instances of a space: guid -> { name, offering }. */
async function serviceInstances(spaceGuid) {
	const { resources: offerings } = await curlAll(`/v3/service_offerings?names=destination,connectivity&space_guids=${spaceGuid}&per_page=200`);
	if (!offerings.length) return new Map();
	const offeringName = new Map(offerings.map((o) => [o.guid, o.name]));

	const { resources: plans } = await curlAll(`/v3/service_plans?service_offering_guids=${[...offeringName.keys()].join(",")}&per_page=200`);
	const planOffering = new Map(plans.map((p) => [p.guid, offeringName.get(p.relationships.service_offering.data.guid)]));
	if (!planOffering.size) return new Map();

	const { resources: instances } = await curlAll(`/v3/service_instances?space_guids=${spaceGuid}&service_plan_guids=${[...planOffering.keys()].join(",")}&per_page=200`);
	return new Map(instances.map((i) => [i.guid, { name: i.name, offering: planOffering.get(i.relationships.service_plan.data.guid) }]));
}

/** Apps of a space bound to both a destination and a connectivity service instance. */
async function boundApps(spaceGuid) {
	const instances = await serviceInstances(spaceGuid);
	const instanceOffering = new Map([...instances].map(([guid, i]) => [guid, i.offering]));
	if (!instanceOffering.size) return [];

	const { resources: bindings, included } = await curlAll(
		`/v3/service_credential_bindings?type=app&service_instance_guids=${[...instanceOffering.keys()].join(",")}&include=app&per_page=200`
	);
	const appNames = new Map((included.apps || []).map((a) => [a.guid, a.name]));
	const servicesByApp = new Map();
	for (const b of bindings) {
		const appGuid = b.relationships.app.data.guid;
		if (!servicesByApp.has(appGuid)) servicesByApp.set(appGuid, new Set());
		servicesByApp.get(appGuid).add(instanceOffering.get(b.relationships.service_instance.data.guid));
	}
	return [...servicesByApp]
		.filter(([, services]) => services.has("destination") && services.has("connectivity"))
		.map(([guid]) => ({ guid, name: appNames.get(guid) || guid }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

async function sshEnabled(appGuid) {
	return curl(`/v3/apps/${appGuid}/ssh_enabled`);
}

async function clientCredentialsToken(creds) {
	const res = await fetch(`${creds.url}/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "client_credentials", client_id: creds.clientid, client_secret: creds.clientsecret })
	});
	if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
	return (await res.json()).access_token;
}

/**
 * Subaccount and service instance destinations visible to the app's destination binding.
 * Instance destinations win over subaccount ones with the same name, as in "find destination".
 */
async function destinations(appGuid) {
	const env = await curl(`/v3/apps/${appGuid}/env`);
	const vcap = env.system_env_json && env.system_env_json.VCAP_SERVICES;
	const binding = vcap && vcap.destination && vcap.destination[0];
	if (!binding) throw new Error("The app has no destination service binding");
	const creds = binding.credentials;
	const token = await clientCredentialsToken(creds);
	const list = async (level) => {
		const res = await fetch(`${creds.uri}/destination-configuration/v1/${level}`, { headers: { authorization: `Bearer ${token}` } });
		if (!res.ok) throw new Error(`Reading ${level} failed: ${res.status} ${await res.text()}`);
		return res.json();
	};
	const [subaccount, instance] = await Promise.all([list("subaccountDestinations"), list("instanceDestinations")]);
	const byName = new Map();
	for (const d of subaccount) byName.set(d.Name, { ...d, level: "subaccount" });
	for (const d of instance) byName.set(d.Name, { ...d, level: "instance" });
	return [...byName.values()].sort((a, b) => a.Name.localeCompare(b.Name));
}

async function target(org, space) {
	await cf(["target", "-o", org, "-s", space]);
}

/* ---------- tunnel app for a space that has none ---------- */

const TUNNEL = { app: "btp-tunnel", destination: "btp-destination", connectivity: "btp-connectivity", plan: "lite" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// some brokers provision asynchronously - binding fails while the instance is still "in progress"
async function waitForInstance(name, timeout = 180000) {
	const guid = await cf(["service", name, "--guid"]);
	for (const end = Date.now() + timeout; ;) {
		const op = (await curl(`/v3/service_instances/${guid}`)).last_operation || {};
		if (op.state === "failed") throw new Error(`Creating the service instance '${name}' failed: ${op.description || "no details"}`);
		if (op.state !== "in progress") return;
		if (Date.now() > end) throw new Error(`The service instance '${name}' is still being created - run the generator again in a few minutes`);
		await sleep(3000);
	}
}

/** Reuses a destination / connectivity instance of the space, else creates one with the lite plan. */
async function ensureInstance(existing, offering, name, log) {
	const found = [...existing.values()].filter((i) => i.offering === offering).map((i) => i.name);
	if (found.length) {
		const reused = found.includes(name) ? name : found[0];
		log(`Using the existing ${offering} service instance '${reused}'`);
		return reused;
	}
	log(`Creating the ${offering} service instance '${name}' (plan ${TUNNEL.plan})`);
	try {
		await cf(["create-service", offering, TUNNEL.plan, name], { timeout: 300000 });
	} catch (e) {
		throw new Error(
			`Could not create the ${offering} service instance: ${e.message} - assign the '${offering}' entitlement with plan '${TUNNEL.plan}' ` +
			"to the subaccount (BTP cockpit > Entitlements) or ask your subaccount administrator"
		);
	}
	await waitForInstance(name);
	return name;
}

/**
 * Creates (or completes) the "btp-tunnel" app: a 64 MB process that only sleeps, bound to a destination and a
 * connectivity instance, with SSH enabled - everything the local proxy needs. Safe to run again after a failure.
 */
async function createTunnelApp(org, space, spaceGuid, log = () => {}) {
	await target(org, space);
	const existing = await serviceInstances(spaceGuid);
	const destination = await ensureInstance(existing, "destination", TUNNEL.destination, log);
	const connectivity = await ensureInstance(existing, "connectivity", TUNNEL.connectivity, log);

	log(`Pushing the app '${TUNNEL.app}' (binary buildpack, 64 MB, no route)`);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "btp-tunnel-"));
	fs.writeFileSync(path.join(dir, "README.txt"), "SSH tunnel app for @scodigis/generator-btp-on-premise-scripts - it only runs 'sleep infinity'.\n");
	try {
		// --no-manifest: never pick up a manifest.yml of the current folder
		await cf(
			["push", TUNNEL.app, "-p", dir, "--no-manifest", "--no-start", "--no-route", "-b", "binary_buildpack", "-m", "64M", "-k", "256M", "-u", "process", "-c", "sleep infinity"],
			{ timeout: 600000 }
		);
	} catch (e) {
		throw new Error(`Could not push the app '${TUNNEL.app}': ${e.message} - the subaccount needs Cloud Foundry Runtime memory quota (64 MB) for the space`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	log(`Binding '${destination}' and '${connectivity}', enabling SSH and starting '${TUNNEL.app}'`);
	await cf(["bind-service", TUNNEL.app, destination], { timeout: 180000 });
	await cf(["bind-service", TUNNEL.app, connectivity], { timeout: 180000 });
	try {
		await cf(["enable-ssh", TUNNEL.app]);
	} catch (e) {
		throw new Error(`Could not enable SSH for '${TUNNEL.app}': ${e.message} - SSH may be disabled for the space (cf allow-space-ssh ${space}, needs the Space Manager role)`);
	}
	await cf(["restart", TUNNEL.app], { timeout: 600000 });
	return TUNNEL.app;
}

module.exports = { loginStatus, loginUrl, loginWithPasscode, loginWithPassword, orgs, spaces, boundApps, sshEnabled, destinations, target, createTunnelApp, TUNNEL };
