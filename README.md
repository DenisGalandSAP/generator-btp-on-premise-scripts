# @scodigis/generator-btp-on-premise-scripts

A Yeoman generator, shown as "BTP On-Premise Access" in the Template Wizard. It lets a SAPUI5 or SAP Fiori
elements app run and deploy from a local machine through on-premise SAP BTP destinations, and gives ABAP
Development Tools and ADT MCP servers the same access (see [ABAP development](#abap-development)). It runs on
Windows, macOS and Linux. The same setup is available as a [Claude Code plugin](#claude-code-plugin).

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
   on GitHub, with a built-in copy for when GitHub cannot be reached. You then log in with user and
   password from an environment variable (you give the user and the variable's name, e.g. `CF_PASSWORD`; both
   are kept in `.env.<env>` so the scripts can log in again on their own), with an SSO passcode (the wizard
   links to the passcode page), or with a password typed for this one login. Add an identity provider origin if
   you use a custom one; it is kept as `BTP_CF_ORIGIN`.
3. Cloud Foundry Target: org, space, and an app bound to both a destination and a connectivity service
   instance, with SSH enabled. If the space has exactly one such app and it is a tunnel app (no route, no other
   service bound), the wizard picks it. A real application, such as a CAP service that happens to have both
   bindings, is never picked without asking: the list marks it and also offers to create a dedicated
   `btp-tunnel` app, so restarting or redeploying the application doesn't cut the tunnel. If the space has no
   such app, the wizard offers to create `btp-tunnel` (see [First-time setup](#first-time-setup)).
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

## ABAP development

The same proxy also serves ABAP Development Tools (VS Code or Eclipse) and ADT MCP servers such as vsp, when the
Cloud Connector exposes `/sap/bc/adt` for the system. Pick "ABAP development" in the wizard's first step (or
`--abap` in the command-line tool) and choose a folder of its own, without `ui5.yaml`: a `package.json` is created
if it has none. Each environment (one per system and client, e.g. `d01-100`) gets:

- `npm run btp-proxy:<env>`: the proxy on `http://127.0.0.1:<port>` and `https://127.0.0.1:<port + 393>`. ADT only
  accepts https, and the proxy answers its `/sap/public/bc/icf/virtualhost` probe itself, because the Cloud
  Connector usually blocks `/sap/public`;
- `scripts/btp-mcp.js <env> -- <command>`: starts the proxy in the background when none runs, then the command,
  for an MCP server that Claude Code starts without a terminal.

The https listener needs a localhost certificate that the ADT Java runtime trusts:

```bash
npx -p @scodigis/generator-btp-on-premise-scripts btp-on-premise-setup adt-cert
```

It creates `~/.config/btp-proxy/localhost.crt` once and imports it into the JRE of ABAP Development Tools for VS
Code. For Eclipse it prints the `keytool` commands for the Java each install runs on: the one `eclipse.ini` names
with `-vm`, else the bundled JRE. It looks for folders whose name starts with `eclipse` (`eclipse`, `eclipse-java`,
`eclipsebare`...) and gives one command per Java, even when several installs share it. Run them with Eclipse closed. Redo after
an extension or Eclipse update. Then add the system as `https://127.0.0.1:<port + 393>`: a destination in VS Code
ADT, an ABAP Cloud Project in Eclipse. `btp-on-premise-setup adt-mcp` prints the `claude mcp add` command for a
vsp server behind the proxy.

## Environments

Each run of the generator sets up one environment. Run it again with a new name (`qual`, `prod`…) to add
another, or with an existing name to change that one. An environment keeps its own Cloud Foundry API
endpoint, org, space, tunnel app, destinations, deploy target and credentials, so `dev` can live in a
subaccount in eu10 and `prod` in another subaccount in eu20.

Before starting a proxy, the scripts point the cf CLI at the environment. If only the org or space differs,
they run `cf target`. If the API endpoint differs or the session has expired, they log in again. With
a user and its password variable (`BTP_CF_USER` and `BTP_CF_PASSWORD_ENV` in `.env.<env>`, else `CF_USERNAME`
and `CF_PASSWORD`) set, they run `cf auth` on their own (with `--origin` when `.env.<env>` has `BTP_CF_ORIGIN`), so a proxy started in the background keeps working too. An environment set
up with single sign-on never uses them. Otherwise they start
`cf login` in the terminal, with `--sso` when the environment was set up with an SSO passcode. Keep the two
variables in your shell profile or a secrets file it loads, never in a file of the project. This changes your global cf
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
| `ui5-btp-<env>.yaml` | `ui5.yaml` with every `fiori-tools-proxy` backend pointing at the environment's proxy (`http://127.0.0.1:5050` for the first) |
| `ui5-deploy-btp-<env>.yaml` | `ui5-deploy.yaml` (or `ui5.yaml`) with the `deploy-to-abap` target on the deploy proxy, written only when there is a deploy destination |
| `.env.<env>` | the `BTP_*` settings (`BTP_CF_API`, org, space, app, destinations, ports) and `USR` / `SAP_PWD`; other keys are kept. `.env` and `.env.<env>` are added to `.gitignore` |
| `package.json` | the scripts `btp-proxy:<env>`, `start-btp:<env>`, `deploy-btp:<env>` and `deploy-btp-test:<env>` |
| `.vscode/launch.json` | a "Run with BTP destination (<env>)" run configuration (`npm run start-btp:<env>`); existing configurations are kept |

The scripts still read a plain `.env` after `.env.<env>`, for values all environments share, such as
`BTP_PROXY_USER` / `BTP_PROXY_PWD`. It never overrides the environment's own values.

Start the app with `npm run start-btp:<env>` or the run configuration. `npm start` and the Fiori tools
Run / Preview still use `ui5.yaml`, whose destination only resolves in SAP Business Application Studio.

A SAPUI5 library (`type: library` in `ui5.yaml`) has nothing to run, so it only gets a deploy destination:
no `ui5-btp-<env>.yaml`, no `start-btp:<env>` and no run configuration. `npm run deploy-btp:<env>` starts the
proxy on that destination itself, like it does for an app, and `deploy-to-abap` runs after
`generateLibraryPreload` instead of `generateCachebusterInfo`.

When the runtime and deploy destinations differ, each gets its own proxy and tunnel; you can change their
ports in `.env.<env>`. The scripts need Node.js 22 or later and the cf CLI, and no extra npm packages.

## Install

```sh
npm install -g @scodigis/generator-btp-on-premise-scripts
```

Reopen the Template Wizard in VS Code or SAP Business Application Studio, and the "BTP On-Premise Access"
tile appears. The VS Code extension in [`vscode-extension/`](vscode-extension) adds the Command Palette entry
"SAP BTP: Generate BTP On-Premise Destination Scripts", which opens this generator directly. From a terminal,
run `yo @scodigis/btp-on-premise-scripts` (this needs `npm i -g yo`).

## Claude Code plugin

The plugin `btp-localhost-on-premise-access` lets Claude Code go through the same steps in a conversation and
start the result. It lives in its own repository, the Scodigis plugin marketplace:
[DenisGalandSAP/scodigis-claude-plugins](https://github.com/DenisGalandSAP/scodigis-claude-plugins).

```text
/plugin marketplace add DenisGalandSAP/scodigis-claude-plugins
/plugin install btp-localhost-on-premise-access@scodigis
```

It calls the command-line tool below through `npx`, pinned to an exact version of this package.

## Command-line tool

`btp-on-premise-setup` runs each step of the wizard as a separate command and prints JSON. The Claude Code
plugin uses it, and it suits scripts too:

```sh
npx -p @scodigis/generator-btp-on-premise-scripts btp-on-premise-setup --help

btp-on-premise-setup status
btp-on-premise-setup apps --org my-org --space dev
btp-on-premise-setup destinations --org my-org --space dev --app btp-tunnel
btp-on-premise-setup apply --project . --env dev --org my-org --space dev --app btp-tunnel \
  --destination SYS_RUNTIME --deploy-destination SYS_DEPLOY --bsp ZMYAPP --package ZPKG --transport SYSK900001 --dry-run
```

`apply` writes the files with the same code as the generator. Destination passwords and client secrets are
never printed, and `SAP_PWD` is shown as `***`. The deploy password is taken from the environment variable
`SAP_PWD` when it is set.

## Development

```sh
npm install
npm link                          # use the working copy as the globally installed generator
npm test                          # type check, then the generator on a copy of test/fixture/app (cf stubbed)
                                  # and the scenarios of test/scenarios.js (fake cf, fake BTP services)
npm run typecheck                 # only the type check: tsc on the JavaScript with JSDoc types (no build)
node test/run.js <app> --verbose  # same on a copy of another app, printing the generated files
```

## Release (npmjs.com)

A pushed version tag publishes the package: the workflow `.github/workflows/publish.yml` checks that the tag
matches `package.json`, runs the tests and publishes with npm trusted publishing (no npm token in GitHub, and a
provenance statement on npmjs.com).

```sh
npm version patch                 # or minor / major - bumps package.json and creates the tag v<version>
npm run pack:check                # check the file list that will be published
git push --follow-tags            # the tag starts the publish workflow
```

Once per package, an owner of the `scodigis` organization on npmjs.com registers the workflow as trusted
publisher (`npm trust` needs npm 11.10 or later; it asks for the two-factor code):

```sh
npm trust github @scodigis/generator-btp-on-premise-scripts --file publish.yml --repo DenisGalandSAP/generator-btp-on-premise-scripts --allow-publish
```

To publish by hand instead: `npm login`, then `npm publish` (runs `npm test` first through `prepublishOnly`).

## Release order

The plugin in [scodigis-claude-plugins](https://github.com/DenisGalandSAP/scodigis-claude-plugins) runs an exact
version of this package (`@scodigis/generator-btp-on-premise-scripts@<version>`). Publish the package to npm
first, then update the pin in the plugin's skills and push the plugin.

## License

[MIT](LICENSE)
