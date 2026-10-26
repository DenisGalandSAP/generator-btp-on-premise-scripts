"use strict";
/*
 * SAP BTP Cloud Foundry regions and their API endpoints.
 * SAP has no public API for them; the list is read from the SAP Help page source on GitHub
 * ("Regions and API Endpoints Available for the Cloud Foundry Environment"), with a built-in copy
 * when that is not reachable.
 */
const SOURCE_URL =
	"https://raw.githubusercontent.com/SAP-docs/btp-cloud-platform/main/docs/10-concepts/regions-and-api-endpoints-available-for-the-cloud-foundry-environment-f344a57.md";

const PROVIDERS = { "Amazon Web Services": "AWS", "Microsoft Azure": "Azure", "SAP Cloud Infrastructure": "SAP" };

// region keys (eu10, eu10-002, ...) of the built-in copy, taken from the page above
const BUILT_IN = [
	["AWS", "Europe (Frankfurt)", "eu10", "eu10-002", "eu10-003", "eu10-004", "eu10-005", "eu11"],
	["AWS", "Europe (Milan)", "eu13"],
	["AWS", "US East (VA)", "us10", "us10-001", "us10-002"],
	["AWS", "US West (Oregon)", "us11"],
	["AWS", "Canada (Montreal)", "ca10"],
	["AWS", "Brazil (São Paulo)", "br10"],
	["AWS", "Japan (Tokyo)", "jp10"],
	["AWS", "Australia (Sydney)", "ap10"],
	["AWS", "Asia Pacific (Singapore)", "ap11"],
	["AWS", "Asia Pacific (Seoul)", "ap12"],
	["Azure", "Europe (Netherlands)", "eu20", "eu20-001", "eu20-002"],
	["Azure", "Europe (Frankfurt)", "eu22"],
	["Azure", "Switzerland (Zurich)", "ch20"],
	["Azure", "UK South (London)", "uk20"],
	["Azure", "US West (WA)", "us20"],
	["Azure", "US East (VA)", "us21"],
	["Azure", "Canada Central (Toronto)", "ca20"],
	["Azure", "Brazil (São Paulo)", "br20"],
	["Azure", "Japan (Tokyo)", "jp20"],
	["Azure", "Australia (Sydney)", "ap20"],
	["Azure", "Singapore", "ap21"],
	["Google Cloud", "Europe (Frankfurt)", "eu30"],
	["Google Cloud", "US Central (IA)", "us30"],
	["Google Cloud", "India (Mumbai)", "in30"],
	["Google Cloud", "Israel (Tel Aviv)", "il30"],
	["Google Cloud", "Japan (Osaka)", "jp30"],
	["Google Cloud", "Japan (Tokyo)", "jp31"],
	["Google Cloud", "KSA (Dammam - KSA Regulated Customers)", "sa30"],
	["Google Cloud", "KSA (Dammam - KSA Non-Regulated Customers)", "sa31"],
	["Google Cloud", "Australia (Sydney)", "ap30"],
	["Google Cloud", "Brazil (São Paulo)", "br30"],
	["SAP", "Europe (Frankfurt) - EU Access Only", "eu01"],
	["SAP", "Europe (Rot) - SAP EU Access", "eu02"],
	["SAP", "US (Sterling)", "us01"],
	["SAP", "US West (Colorado)", "us02"],
	["SAP", "Japan (Tokyo)", "jp01"],
	["SAP", "Australia (Sydney)", "ap01"],
	["SAP", "UAE (Dubai)", "ae01"]
].flatMap(([provider, location, ...keys]) =>
	keys.map((key) => ({ key, api: `https://api.cf.${key}.hana.ondemand.com`, location, provider })));

const cellText = (html) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replace(/\\([()[\]])/g, "$1") // markdown escapes
		.replace(/\s+/g, " ")
		.trim();

/** Regions of the HTML tables in the page: one entry per API endpoint (a row can list several). */
function parse(markdown) {
	const regions = new Map();
	for (const table of markdown.split(/<table[^>]*>/).slice(1)) {
		const rows = table.split(/<\/table>/)[0].split(/<tr[^>]*>/).slice(1)
			.map((row) => row.split(/<t[dh][^>]*>/).slice(1).map(cellText));
		const header = rows.shift() || [];
		const col = (name) => header.findIndex((h) => h.toLowerCase() === name);
		const [provider, location, endpoint] = [col("iaas provider"), col("region name"), col("api endpoint")];
		if (provider < 0 || location < 0 || endpoint < 0) continue;
		for (const row of rows) {
			for (const host of (row[endpoint] || "").match(/\bapi\.cf\.[a-z0-9-]+(?:\.[a-z0-9-]+)+/g) || []) {
				const api = `https://${host}`;
				if (regions.has(api)) continue; // the trial table repeats regions
				regions.set(api, { key: host.split(".")[2], api, location: row[location], provider: PROVIDERS[row[provider]] || row[provider] });
			}
		}
	}
	return [...regions.values()];
}

const regionOrder = (a, b) => a.key.localeCompare(b.key, "en", { numeric: true });

/** Regions from SAP Help, or the built-in copy (source: "built-in") when it cannot be read. */
async function list({ timeout = 5000 } = {}) {
	try {
		const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(timeout) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const regions = parse(await res.text());
		// a page that does not parse any more is no better than the built-in copy
		if (regions.length < 10) throw new Error("unexpected page format");
		return { source: "SAP Help", regions: regions.sort(regionOrder) };
	} catch (e) {
		return { source: "built-in", error: e.message, regions: [...BUILT_IN].sort(regionOrder) };
	}
}

module.exports = { list, parse, BUILT_IN, SOURCE_URL };
