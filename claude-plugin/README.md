# BTP On-Premise Access for Claude Code

Lets a SAPUI5 or SAP Fiori elements app run and deploy from your local machine through on-premise SAP BTP
destinations. The app's backend calls go to a local proxy, which reaches the Cloud Connector through a
`cf ssh` tunnel to the connectivity proxy of a Cloud Foundry app.

Install it with:

```text
/plugin install btp-on-premise-access --marketplace DenisGalandSAP/generator-btp-on-premise-scripts
```

Then ask Claude something like "set up this app to run through our BTP destination for dev". Claude asks for the
environment, the Cloud Foundry region, org, space and app, and the runtime and deploy destinations. It shows a
dry run of the files, then writes them into the project:

- `scripts/btp-proxy.js`, `scripts/btp.js`, `scripts/btp-env.js`: the proxy and the start / deploy wrappers;
- `ui5-btp-<env>.yaml` and `ui5-deploy-btp-<env>.yaml`;
- `.env.<env>` with the settings, added to `.gitignore`;
- the npm scripts `start-btp:<env>`, `deploy-btp:<env>`, `deploy-btp-test:<env>` and `btp-proxy:<env>`.

The skill runs the command-line tool of the npm package
[`@scodigis/generator-btp-on-premise-scripts`](https://www.npmjs.com/package/@scodigis/generator-btp-on-premise-scripts)
through `npx`, the same code as the "BTP On-Premise Access" generator of the SAP Fiori tools Template Wizard.

## Requirements

- Node.js 22 or later and the [cf CLI](https://github.com/cloudfoundry/cli) v8;
- a BTP subaccount with the Destination and Connectivity services, a connected Cloud Connector, and OnPremise
  destinations with `NoAuthentication` or `BasicAuthentication`;
- the SpaceDeveloper role in the Cloud Foundry space, with SSH allowed.

## Data handling

Everything runs on your machine, and nothing is sent to the plugin's author. The tool and the scripts it
writes connect to:

- the Cloud Foundry API and login server of your own region, through the cf CLI and your existing session;
- the Destination service and its token endpoint in your own subaccount, with the credentials of the app's
  service binding, to list destinations;
- the connectivity proxy of your subaccount, through the `cf ssh` tunnel, which forwards your app's requests to
  the Cloud Connector and your backend;
- `raw.githubusercontent.com`, for SAP's public list of Cloud Foundry regions (a plain download, nothing is
  sent);
- the npm registry, when `npx` downloads the package.

The settings it writes stay in your project: `.env.<env>` holds the org, space, app and destination names, and,
only when you enter them, the ABAP user and password for deployment. Destination passwords and client secrets
are never shown to Claude. Claude never asks for a password in the chat: a password login
happens in your own terminal, and you type the ABAP deploy password into `.env.<env>` yourself.

Source, setup details and troubleshooting:
https://github.com/DenisGalandSAP/generator-btp-on-premise-scripts

## License

[MIT](LICENSE)
