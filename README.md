# @scodigis/generator-btp-on-premise-scripts

A Yeoman generator, shown as "BTP On-Premise Access" in the Template Wizard. It lets a SAPUI5 or SAP Fiori
elements app run and deploy from a local machine through on-premise SAP BTP destinations.

The app's backend calls go to a local proxy (`scripts/btp-proxy.js`). The proxy reads the destination and
connectivity service keys from the environment of a Cloud Foundry app and opens `cf ssh -L` to the
connectivity proxy. Each request is then forwarded with the connectivity token, the Cloud Connector location
id, the `sap-client` and the destination's logon.

## First-time setup

You do this once per subaccount and space. Everyone who uses the scripts there shares the result.

In the BTP cockpit, a subaccount administrator needs to make sure that:

- the subaccount has the entitlements Destination (plan `lite`), Connectivity (plan `lite`) and Cloud Foundry
  Runtime (64 MB of memory is enough);
- the Cloud Connector is connected to the subaccount and exposes the backend system;
- the OnPremise destinations are defined at subaccount level (Connectivity > Destinations).

The Cloud Foundry space also needs an app for the proxy to tunnel through. If the space has none, the wizard
creates one. To do it by hand:

```sh
cf target -o <org> -s <space>
cf create-service destination lite btp-destination
cf create-service connectivity lite btp-connectivity

# a 64 MB app that only sleeps - any folder works, the content is not used
mkdir btp-tunnel && cd btp-tunnel && echo > README.txt
cf push btp-tunnel --no-manifest --no-start --no-route -b binary_buildpack -m 64M -k 256M -u process -c "sleep infinity"

cf bind-service btp-tunnel btp-destination
cf bind-service btp-tunnel btp-connectivity
cf enable-ssh btp-tunnel
cf restart btp-tunnel
```

You can bind destination and connectivity instances that already exist in the space instead of creating new
ones. If `cf enable-ssh` fails, SSH is disabled for the space, and a Space Manager has to run
`cf allow-space-ssh <space>`.

## Wizard steps

1. Project: pick the app folder. It must contain `package.json`, `ui5.yaml` and `webapp/manifest.json`
   (SAPUI5 freestyle or SAP Fiori elements V2/V4). Then name the environment (`dev`, `qual`, `prod`…, see
   [Environments](#environments)). If you are logged in to Cloud Foundry, you also choose between the current
   session and a login to another region or subaccount. The page notes that a SAP system you can reach
   directly does not need this generator; add it with the Service Center of SAP Fiori tools instead.
2. Cloud Foundry Endpoint and Login: shown when there is no cf session, when it has expired, or when you
   chose another region. Pick the region from the list of SAP BTP Cloud Foundry regions or enter an API
   endpoint. SAP has no public API for the regions, so the list comes from the source of the SAP Help page
   [Regions and API Endpoints Available for the Cloud Foundry Environment](https://help.sap.com/docs/btp/sap-business-technology-platform/regions-and-api-endpoints-available-for-cloud-foundry-environment)
   on GitHub, with a built-in copy for when GitHub cannot be reached. You then log in with an SSO passcode
   (the wizard links to the passcode page) or with user and password, plus an identity provider origin if
   you use a custom one.
3. Cloud Foundry Target: org, space, and an app bound to both a destination and a connectivity service
   instance, with SSH enabled. If the space has exactly one such app, the wizard picks it. If it has none,
   the wizard offers to create `btp-tunnel` (see [First-time setup](#first-time-setup)).
4. Destinations: the runtime destination for `npm run start-btp:<env>` and, if you want one, the deploy
   destination for `npm run deploy-btp:<env>`. Leave *Also deploy through a BTP destination* unchecked to
   skip the Deployment step; the environment then gets no `ui5-deploy-btp-<env>.yaml`, no `deploy-btp:<env>`
   scripts and no `BTP_DEPLOY_*` keys in `.env.<env>`. Only OnPremise HTTP destinations with
   `NoAuthentication` or `BasicAuthentication` work. The defaults come from `.env.<env>`, or else from the
   `destination` in `ui5.yaml` / `ui5-deploy.yaml` if the app can see a destination of that name.
5. Deployment: BSP name, package, transport and client. The defaults come from the environment's
   `ui5-deploy-btp-<env>.yaml`, then another environment's one, then `ui5-deploy.yaml`. If the deploy
   destination has `NoAuthentication`, the wizard asks for the ABAP user and password and writes them to
   `.env.<env>` (`USR` / `SAP_PWD`).

## Environments

Each run of the generator sets up one environment. Run it again with a new name (`qual`, `prod`…) to add
another, or with an existing name to change that one. An environment keeps its own Cloud Foundry API
endpoint, org, space, tunnel app, destinations, deploy target and credentials, so `dev` can live in a
subaccount in eu10 and `prod` in another subaccount in eu20.

Before starting a proxy, the scripts point the cf CLI at the environment. If only the org or space differs,
they run `cf target`. If the API endpoint differs or the session has expired, they start `cf login` in the
terminal, with `--sso` when the environment was set up with an SSO passcode. This changes your global cf
target, so you cannot start two environments on different API endpoints at the same moment: start one, wait
until its proxy is up, then start the other. Environments on the same endpoint can run side by side because
each gets its own ports (5050 / 20003 and 5051 / 20004 for the first, then 2 higher for each further one).

Projects set up with an earlier version keep their settings in `.env` and use `npm run start-btp`. The first
run of this version moves those settings to `.env.<env>` and replaces the old `ui5-btp.yaml`,
`ui5-deploy-btp.yaml`, npm scripts and run configuration with the environment's own.

## What it writes into the project

For an environment `<env>`:

| File | Content |
| --- | --- |
| `scripts/btp-proxy.js`, `scripts/btp.js`, `scripts/btp-env.js` | the proxy, the start / deploy wrapper, and the environment loading and cf targeting, shared by all environments |
| `ui5-btp-<env>.yaml` | `ui5.yaml` with every `fiori-tools-proxy` backend pointing at the environment's proxy (`http://localhost:5050` for the first) |
| `ui5-deploy-btp-<env>.yaml` | `ui5-deploy.yaml` (or `ui5.yaml`) with the `deploy-to-abap` target on the deploy proxy, written only when there is a deploy destination |
| `.env.<env>` | the `BTP_*` settings (`BTP_CF_API`, org, space, app, destinations, ports) and `USR` / `SAP_PWD`; other keys are kept. `.env` and `.env.<env>` are added to `.gitignore` |
| `package.json` | the scripts `btp-proxy:<env>`, `start-btp:<env>`, `deploy-btp:<env>` and `deploy-btp-test:<env>` |
| `.vscode/launch.json` | a "Run with BTP destination (<env>)" run configuration (`npm run start-btp:<env>`); existing configurations are kept |

The scripts still read a plain `.env` after `.env.<env>`, for values all environments share, such as
`BTP_PROXY_USER` / `BTP_PROXY_PWD`. It never overrides the environment's own values.

Start the app with `npm run start-btp:<env>` or the run configuration. `npm start` and the Fiori tools
Run / Preview still use `ui5.yaml`, whose destination only resolves in SAP Business Application Studio.

When the runtime and deploy destinations differ, each gets its own proxy and tunnel; you can change their
ports in `.env.<env>`. The scripts need Node.js 20.12 or later and the cf CLI, and no extra npm packages.

## Install

```sh
npm install -g @scodigis/generator-btp-on-premise-scripts
```

Reopen the Template Wizard in VS Code or SAP Business Application Studio, and the "BTP On-Premise Access"
tile appears. The VS Code extension in [`vscode-extension/`](vscode-extension) adds the Command Palette entry
"SAP BTP: Generate BTP On-Premise Destination Scripts", which opens this generator directly. From a terminal,
run `yo @scodigis/btp-on-premise-scripts` (this needs `npm i -g yo`).

## Development

```sh
npm install
npm link                          # use the working copy as the globally installed generator
npm test                          # runs the generator on a copy of test/fixture/app, with cf stubbed
node test/run.js <app> --verbose  # same on a copy of another app, printing the generated files
```

## Release (npmjs.com)

Publishing needs the `scodigis` organization on npmjs.com (free for public packages) and your npm user as a
member with publish rights. Two-factor authentication is recommended.

```sh
npm login                         # once per machine
npm version patch                 # or minor / major - bumps package.json (and tags, in a git repo)
npm run pack:check                # check the file list that will be published
npm publish                       # runs npm test first (prepublishOnly); publishConfig makes it public
```

## License

[MIT](LICENSE)
