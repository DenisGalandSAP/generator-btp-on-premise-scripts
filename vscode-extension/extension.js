"use strict";
/*
 * Command Palette entry for the BTP On-Premise Access generator. The Template Wizard (SAPOS.yeoman-ui) opens
 * the generator directly, or offers to install it when @scodigis/generator-btp-on-premise-scripts is missing.
 * The generator itself picks the Fiori app of the open workspace as the default project.
 */
const vscode = require("vscode");

const GENERATOR = "@scodigis/btp-on-premise-scripts:app";

function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand("btpOnPremiseAccess.generate", () =>
			vscode.commands.executeCommand("loadYeomanUI", { generator: GENERATOR })
		)
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
