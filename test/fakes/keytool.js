#!/usr/bin/env node
"use strict";
/*
 * A fake keytool for the adt-cert scenarios. It lives in <jre>/bin and keeps the imported certificate's SHA-256 in
 * <jre>/imported.sha256, logs its calls to <jre>/keytool.log and needs <jre>/lib/security/cacerts to exist.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const jre = path.join(__dirname, "..");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(jre, "keytool.log"), `${args.join(" ")}\n`);
const opt = (name) => args[args.indexOf(name) + 1];
const imported = path.join(jre, "imported.sha256");
const sha = (file) => {
	const pem = fs.readFileSync(file, "utf8").replace(/-----[^-]+-----|\s/g, "");
	return crypto.createHash("sha256").update(Buffer.from(pem, "base64")).digest("hex").toUpperCase().match(/../g).join(":");
};

if (!fs.existsSync(path.join(jre, "lib", "security", "cacerts"))) {
	process.stderr.write("keytool error: cacerts not found\n");
	process.exit(1);
}
if (args.includes("-list")) {
	if (!fs.existsSync(imported)) {
		process.stderr.write(`keytool error: java.lang.Exception: Alias <${opt("-alias")}> does not exist\n`);
		process.exit(1);
	}
	console.log(`${opt("-alias")}, Nov 6, 2026, trustedCertEntry,\nCertificate fingerprint (SHA-256): ${fs.readFileSync(imported, "utf8")}`);
} else if (args.includes("-printcert")) {
	console.log(`Owner: CN=localhost\nCertificate fingerprints:\n\t SHA1: 00\n\t SHA256: ${sha(opt("-file"))}\nSignature algorithm name: SHA256withRSA`);
} else if (args.includes("-delete")) {
	if (!fs.existsSync(imported)) process.exit(1);
	fs.rmSync(imported);
} else if (args.includes("-importcert")) {
	fs.writeFileSync(imported, sha(opt("-file")));
	console.log("Certificate was added to keystore");
} else {
	process.exit(2);
}
