"use strict";
/*
 * ABAP Development Tools through the btp-proxy: the localhost certificate of its https listener, the JREs that
 * have to trust it, and the command that registers an ADT MCP server. Used by bin/btp-setup.js (adt-cert, adt-mcp).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ALIAS = "btp-proxy-localhost";
const STOREPASS = "changeit";
const tlsDir = () => process.env.BTP_PROXY_TLS_DIR || path.join(os.homedir(), ".config", "btp-proxy");
const isWsl = () => {
	try {
		return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
	} catch (e) {
		return false;
	}
};
const ls = (dir) => {
	try {
		return fs.readdirSync(dir);
	} catch (e) {
		return [];
	}
};
const exe = (name) => (process.platform === "win32" ? `${name}.exe` : name);
// the Java home inside a jre folder: the folder itself, or jre/Contents/Home in a macOS bundle
const javaHome = (jre) => [jre, path.join(jre, "Contents", "Home")].find((h) => fs.existsSync(path.join(h, "bin", exe("keytool"))));

/** Creates localhost.crt / localhost.key (self-signed, SAN localhost + 127.0.0.1, 825 days) unless they exist. */
function ensureCert({ renew = false, dryRun = false } = {}) {
	const dir = tlsDir();
	const cert = path.join(dir, "localhost.crt");
	const key = path.join(dir, "localhost.key");
	const exists = fs.existsSync(cert) && fs.existsSync(key);
	if (exists && !renew) return { cert, key, created: false };
	if (dryRun) return { cert, key, created: true };
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825", "-subj", "/CN=localhost",
			"-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert], { stdio: ["ignore", "ignore", "pipe"] });
	} catch (e) {
		throw new Error(`openssl failed (${(e.stderr || e.message).toString().trim().split("\n").pop()}) - install OpenSSL (on Windows it comes with Git for Windows) and run adt-cert again`);
	}
	fs.chmodSync(key, 0o600);
	return { cert, key, created: true };
}

/** JREs of the ABAP Development Tools language server for VS Code (local and VS Code Server / WSL / remote). */
function vscodeJres() {
	const found = [];
	for (const base of [".vscode-server", ".vscode", ".vscode-insiders", ".vscode-server-insiders"]) {
		const ext = path.join(os.homedir(), base, "extensions");
		for (const name of ls(ext).filter((n) => n.startsWith("sapse.adt-vscode-"))) {
			// adt-ls/<os>/<ws>/<arch>/plugins/com.sap.adt.jvm.*/jre - search a few levels instead of hard-coding them
			const stack = [[path.join(ext, name, "adt-ls"), 0]];
			while (stack.length) {
				const [dir, depth] = stack.pop();
				if (path.basename(dir) === "jre" && javaHome(dir)) {
					found.push({ extension: name, jre: javaHome(dir) });
					continue;
				}
				if (depth >= 8) continue;
				for (const child of ls(dir)) {
					const p = path.join(dir, child);
					try {
						if (fs.statSync(p).isDirectory()) stack.push([p, depth + 1]);
					} catch (e) { /* broken link */ }
				}
			}
		}
	}
	return found;
}

/** Whether the JRE already trusts this certificate (same alias and fingerprint). */
function trusted(jre, cert) {
	const keytool = path.join(jre, "bin", exe("keytool"));
	try {
		const listed = execFileSync(keytool, ["-list", "-alias", ALIAS, "-cacerts", "-storepass", STOREPASS], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		const printed = execFileSync(keytool, ["-printcert", "-file", cert], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		const sha = (text) => ((/SHA-?256\)?:\s*([0-9A-F:]+)/i.exec(text) || [])[1] || "").toUpperCase();
		return !!sha(listed) && sha(listed) === sha(printed);
	} catch (e) {
		return false;
	}
}

/** Imports the certificate into a JRE's cacerts (kept as cacerts.orig the first time). */
function trust(jre, cert) {
	const keytool = path.join(jre, "bin", exe("keytool"));
	const cacerts = path.join(jre, "lib", "security", "cacerts");
	if (!fs.existsSync(`${cacerts}.orig`)) fs.copyFileSync(cacerts, `${cacerts}.orig`);
	// a renewed certificate replaces the old entry
	try {
		execFileSync(keytool, ["-delete", "-alias", ALIAS, "-cacerts", "-storepass", STOREPASS], { stdio: "ignore" });
	} catch (e) { /* not there yet */ }
	execFileSync(keytool, ["-importcert", "-noprompt", "-alias", ALIAS, "-file", cert, "-cacerts", "-storepass", STOREPASS], { stdio: ["ignore", "ignore", "pipe"] });
}

// a Windows path (C:\x or C:/x) as WSL sees it: /mnt/c/x
const fromWindows = (p) => {
	const m = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
	return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}` : p;
};

/**
 * The Java home Eclipse runs on when eclipse.ini names one with -vm (the next line: a javaw.exe, a bin folder or
 * a Java home, absolute or relative to the install), else undefined.
 */
function vmJavaHome(install, ini = (() => {
	try {
		return fs.readFileSync(path.join(install, "eclipse.ini"), "utf8");
	} catch (e) {
		return "";
	}
})()) {
	const lines = ini.split(/\r?\n/).map((l) => l.trim());
	const at = lines.indexOf("-vm");
	if (at < 0 || !lines[at + 1]) return undefined;
	let vm = lines[at + 1];
	if (isWsl()) vm = fromWindows(vm);
	else if (process.platform !== "win32") vm = vm.replace(/\\/g, "/");
	if (!path.isAbsolute(vm) && !/^[a-zA-Z]:[\\/]/.test(vm)) vm = path.join(install, vm);
	// .../bin/javaw.exe or .../bin/java -> the Java home; .../bin -> its parent
	if (/[\\/]bin[\\/]javaw?(\.exe)?$/i.test(vm)) vm = path.dirname(path.dirname(vm));
	else if (/[\\/]bin[\\/]?$/i.test(vm)) vm = path.dirname(vm.replace(/[\\/]$/, ""));
	return vm;
}

/**
 * Eclipse installations (folders named eclipse*, e.g. eclipse, eclipse-java, eclipsebare) and the Java they run on:
 * the one eclipse.ini names with -vm, else the bundled JustJ JRE. Windows or seen from WSL, Linux, macOS.
 */
function eclipseJres() {
	const roots = [];
	const eclipseDirs = (parent) => ls(parent).filter((n) => /^eclipse/i.test(n)).map((n) => path.join(parent, n));
	if (process.platform === "win32") {
		for (const drive of ["C:\\", "D:\\", "E:\\"]) roots.push(...eclipseDirs(drive));
		if (process.env.USERPROFILE) roots.push(...eclipseDirs(process.env.USERPROFILE));
	} else if (isWsl()) {
		for (const drive of ls("/mnt").filter((d) => /^[a-z]$/.test(d))) roots.push(...eclipseDirs(`/mnt/${drive}`));
		for (const user of ls("/mnt/c/Users")) roots.push(...eclipseDirs(`/mnt/c/Users/${user}`));
	} else {
		roots.push(...eclipseDirs(os.homedir()), ...eclipseDirs("/opt"));
		// macOS: /Applications/Eclipse*.app, ~/eclipse/<package>/Eclipse.app (Eclipse installer)
		for (const app of ls("/Applications").filter((n) => /^eclipse.*\.app$/i.test(n))) roots.push(path.join("/Applications", app, "Contents", "Eclipse"));
		for (const child of ls(path.join(os.homedir(), "eclipse"))) roots.push(path.join(os.homedir(), "eclipse", child, "Eclipse.app", "Contents", "Eclipse"));
	}
	// a user folder may hold eclipse/<package>/eclipse (Eclipse installer)
	const installs = [];
	for (const root of roots) {
		if (fs.existsSync(path.join(root, "plugins"))) installs.push(root);
		for (const child of ls(root)) if (fs.existsSync(path.join(root, child, "eclipse", "plugins"))) installs.push(path.join(root, child, "eclipse"));
	}
	return installs.map((install) => {
		const vm = vmJavaHome(install);
		if (vm && fs.existsSync(vm)) return { install, jre: javaHome(vm) || vm, source: "eclipse.ini -vm" };
		const jres = ls(path.join(install, "plugins"))
			.filter((n) => /^org\.eclipse\.justj\.openjdk\.hotspot\.jre\.full\./.test(n) && fs.existsSync(path.join(install, "plugins", n, "jre")))
			.sort();
		const jre = jres.length ? path.join(install, "plugins", jres[jres.length - 1], "jre") : undefined;
		// seen from WSL the Windows keytool.exe cannot be checked with exe(): keep the folder as is
		return { install, jre: jre && (javaHome(jre) || jre), source: "bundled" };
	}).filter((e) => e.jre);
}

const toWindows = (p) => {
	const m = /^\/mnt\/([a-z])\/(.*)$/.exec(p);
	if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
	// a file inside WSL, as Windows sees it
	return process.env.WSL_DISTRO_NAME ? `\\\\wsl.localhost\\${process.env.WSL_DISTRO_NAME}${p.replace(/\//g, "\\")}` : p;
};

/** PowerShell (Windows / WSL) or shell commands that make an Eclipse JRE trust the certificate - Eclipse closed. */
function eclipseCommands({ install, jre }, cert) {
	if (process.platform === "win32" || isWsl()) {
		const w = toWindows(jre);
		return {
			install: toWindows(install),
			shell: "powershell",
			command: [
				`$jre = '${w}'`,
				"Copy-Item \"$jre\\lib\\security\\cacerts\" \"$jre\\lib\\security\\cacerts.orig\" -ErrorAction SilentlyContinue",
				`& "$jre\\bin\\keytool.exe" -delete -alias ${ALIAS} -keystore "$jre\\lib\\security\\cacerts" -storepass ${STOREPASS} 2>$null`,
				`& "$jre\\bin\\keytool.exe" -importcert -noprompt -alias ${ALIAS} -file '${toWindows(cert)}' -keystore "$jre\\lib\\security\\cacerts" -storepass ${STOREPASS}`
			].join("\n")
		};
	}
	return {
		install,
		shell: "sh",
		command: `"${jre}/bin/keytool" -importcert -noprompt -alias ${ALIAS} -file "${cert}" -cacerts -storepass ${STOREPASS}`
	};
}

/**
 * `claude mcp add` arguments for an ADT MCP server (vsp) behind the environment's proxy. vsp talks plain http to the
 * proxy, which adds the destination's credentials, so its own password is a placeholder.
 */
function mcpCommand({ root, env, values, vsp, name, scope = "local", user, client, readOnly, allowedPackages }) {
	const port = Number(values.BTP_PROXY_PORT || 5050);
	const args = ["claude", "mcp", "add", "-s", scope, name, "--",
		"node", path.join(root, "scripts", "btp-mcp.js"), env, "--",
		vsp, "--url", `http://127.0.0.1:${port}`, "--user", user, "--password", "via-destination"];
	if (client) args.push("--client", client);
	if (readOnly) args.push("--read-only");
	if (allowedPackages) args.push("--allowed-packages", allowedPackages);
	return args;
}

module.exports = { ensureCert, vscodeJres, trusted, trust, eclipseJres, eclipseCommands, mcpCommand, tlsDir, toWindows, fromWindows, vmJavaHome, isWsl, ALIAS };
