# @scodigis/generator-btp-on-premise-scripts

Yeoman generator ("BTP On-Premise Access" in the Template Wizard) that lets a SAPUI5 / SAP Fiori elements
app run and deploy through **on-premise SAP BTP destinations** from a local machine.

The app's backend calls go to a local proxy (`scripts/btp-proxy.js`). The proxy reads the destination and
connectivity service keys from a Cloud Foundry app's environment, opens `cf ssh -L` to the connectivity
proxy, and forwards each request with the connectivity token, the Cloud Connector location id, the
`sap-client` and the destination's logon.

## Wizard steps

1. **Project** – the folder must contain `package.json`, `ui5.yaml` and `webapp/manifest.json`
   (SAPUI5 freestyle or SAP Fiori elements V2/V4).
2. **Cloud Foundry Endpoint / Login** – only shown when the cf session is missing or expired.
   Pick the region from the list of SAP BTP Cloud Foundry regions (or enter another API endpoint),
   then log in with an SSO passcode (the wizard links to the passcode page) or user + password with
   an optional identity provider origin.
3. **Cloud Foundry Target** – org, space and an app bound to a *destination* **and** a *connectivity*
   service instance. SSH must be enabled for the app.
4. **Destinations** – runtime destination (`npm run start-btp`) and deploy destination (`npm run deploy-btp`).
   Only OnPremise HTTP destinations with `NoAuthentication` or `BasicAuthentication` work.
   Prefilled from `.env`, else from the `destination` in `ui5.yaml` / `ui5-deploy.yaml` when the
   app can see a destination of that name.
5. **Deployment** – BSP name, package, transport, client, prefilled from an existing
   `ui5-deploy-btp.yaml` or `ui5-deploy.yaml`. If the deploy destination has
   `NoAuthentication`, the ABAP user and password are asked and written to `.env` (`USR` / `SAP_PWD`).

## What it writes into the project

| File | Content |
| --- | --- |
| `scripts/btp-proxy.js`, `scripts/btp.js` | proxy and the start / deploy wrapper |
| `ui5-btp.yaml` | `ui5.yaml` with every `fiori-tools-proxy` backend pointing at `http://localhost:5050` |
| `ui5-deploy-btp.yaml` | `ui5-deploy.yaml` (or `ui5.yaml`) with the `deploy-to-abap` target on the deploy proxy |
| `.env` | `BTP_*` settings (+ `USR` / `SAP_PWD`); other keys are kept, `.env` is added to `.gitignore` |
| `package.json` | `btp-proxy`, `start-btp`, `deploy-btp`, `deploy-btp-test` scripts |
| `.vscode/launch.json` | "Run with BTP destination (cf ssh)" run configuration (`npm run start-btp`); existing configurations are kept |

Start the app with `npm run start-btp` or that run configuration. `npm start` and the Fiori tools
Run / Preview still use `ui5.yaml`, whose destination only resolves in SAP Business Application Studio.

When the runtime and deploy destinations differ, each gets its own proxy / tunnel
(5050 / 20003 and 5051 / 20004 – change them in `.env`). The scripts need Node.js 20.12+ and the cf CLI,
and no extra npm packages.

## Install

```sh
npm install -g @scodigis/generator-btp-on-premise-scripts
```

Reopen the Template Wizard in VS Code / SAP Business Application Studio; the "BTP On-Premise Access" tile
appears there. From a terminal (needs `npm i -g yo`), run `yo @scodigis/btp-on-premise-scripts`.

## Development

```sh
npm install
npm link                          # use the working copy as the globally installed generator
npm test                          # runs the generator on a copy of test/fixture/app, with cf stubbed
node test/run.js <app> --verbose  # same on a copy of another app, printing the generated files
```

## Release (npmjs.com)

One-time setup: the `scodigis` organization on npmjs.com (free for public packages), and your npm user as a
member with publish rights. Two-factor authentication is recommended.

```sh
npm login                         # once per machine
npm version patch                 # or minor / major - bumps package.json (and tags, in a git repo)
npm run pack:check                # check the file list that will be published
npm publish                       # runs npm test first (prepublishOnly); publishConfig makes it public
```

## License

[MIT](LICENSE)
