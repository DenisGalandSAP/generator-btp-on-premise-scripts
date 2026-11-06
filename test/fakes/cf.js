#!/usr/bin/env node
"use strict";
/*
 * A fake cf CLI for the scenario tests (test/scenarios.js), in Node so it runs on Windows, macOS and Linux.
 * State lives in FAKE_CF_DIR: state.json (api, authed, org, space), calls.log (one line per call, the password
 * only as "set"), app-env.json (what `cf curl /v3/apps/<guid>/env` returns), ssh.pid (the running tunnel).
 *
 * Passwords for `cf auth` (from CF_PASSWORD): "good" logs in, "net" fails like a network error, anything else is
 * rejected like a wrong password. Like the real cf, auth clears the org / space target.
 */
const fs = require("fs");
const net = require("net");
const path = require("path");

const dir = /** @type {string} */ (process.env.FAKE_CF_DIR);
const stateFile = path.join(dir, "state.json");
const state = fs.existsSync(stateFile)
	? JSON.parse(fs.readFileSync(stateFile, "utf8"))
	: { api: "https://api.cf.eu10.hana.ondemand.com", authed: false, org: "my-org", space: "dev" };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), `${args.join(" ")} | user=${process.env.CF_USERNAME || ""} | pw=${process.env.CF_PASSWORD ? "set" : ""}\n`);
const fail = (msg) => {
	process.stderr.write(`${msg}\n`);
	process.exit(1);
};
const opt = (name) => args[args.indexOf(name) + 1];

switch (args[0]) {
	case "api":
		if (args[1]) {
			state.api = args[1];
			state.authed = false;
			save();
		} else {
			console.log(`API endpoint:   ${state.api}\nAPI version:    3.200.0`);
		}
		break;
	case "target":
		if (args.includes("-o")) {
			if (!state.authed) fail("Not logged in. Use 'cf login' to log in.");
			if (opt("-o") === "bad-org") fail("Organization 'bad-org' not found.\nFAILED");
			state.org = opt("-o");
			state.space = opt("-s");
			save();
		}
		// like the real cf, target answers from the config even when the token has expired
		console.log(`API endpoint:   ${state.api}\nuser:           me\norg:            ${state.org}\nspace:          ${state.space}`);
		break;
	case "oauth-token":
		if (!state.authed) fail("The token expired, was revoked, or the token ID is incorrect. Please log back in to re-authenticate.");
		console.log("bearer fake-token");
		break;
	case "auth": {
		const password = process.env.CF_PASSWORD;
		if (password === "good") {
			Object.assign(state, { authed: true, org: "", space: "" });
			save();
			console.log("Authenticating...\nOK");
		} else if (password === "net") {
			fail("Authenticating...\nGet \"https://login.example/oauth/token\": dial tcp: i/o timeout\nFAILED");
		} else {
			fail("Authenticating...\nCredentials were rejected, please try again.\nFAILED");
		}
		break;
	}
	case "app":
		if (!state.authed) fail("The token expired");
		console.log("guid-1");
		break;
	case "curl": {
		if (!state.authed) fail("The token expired");
		// v3.json (optional): { "<path prefix>": <answer> } - the longest matching prefix answers, else app-env.json
		const v3File = path.join(dir, "v3.json");
		const routes = fs.existsSync(v3File) ? JSON.parse(fs.readFileSync(v3File, "utf8")) : {};
		const key = Object.keys(routes).filter((k) => args[1].startsWith(k)).sort((a, b) => b.length - a.length)[0];
		process.stdout.write(key ? JSON.stringify(routes[key]) : fs.readFileSync(path.join(dir, "app-env.json"), "utf8"));
		break;
	}
	case "ssh": {
		// -L [bind:]localport:host:port - forward like the real tunnel, until killed
		const spec = opt("-L").split(":");
		const [bind, localPort, host, port] = spec.length === 4 ? spec : ["127.0.0.1", ...spec];
		fs.writeFileSync(path.join(dir, "ssh.pid"), String(process.pid));
		net.createServer((client) => {
			const upstream = net.connect(Number(port), host);
			client.pipe(upstream).pipe(client);
			client.on("error", () => upstream.destroy());
			upstream.on("error", () => client.destroy());
		}).listen(Number(localPort), bind);
		process.on("SIGTERM", () => process.exit(0));
		break;
	}
	default:
		fail(`fake cf: unknown command ${args[0]}`);
}
