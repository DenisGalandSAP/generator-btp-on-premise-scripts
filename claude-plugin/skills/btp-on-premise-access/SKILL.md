---
name: btp-on-premise-access
description: Set up a SAPUI5 or SAP Fiori elements app so it runs and deploys from the local machine through on-premise SAP BTP destinations (Cloud Connector), via a cf ssh tunnel to the connectivity proxy. Use when the user wants to run `npm start` / preview / deploy a UI5 app against an on-premise ABAP system that is only reachable through a BTP destination, add an environment (dev, qual, prod) for that, or fix such a setup (start-btp / deploy-btp scripts, .env.<env>, ui5-btp-<env>.yaml).
---

# BTP On-Premise Access

You do what the "BTP On-Premise Access" Template Wizard does, by talking to the user and running the CLI
`btp-on-premise-setup` from the npm package `@scodigis/generator-btp-on-premise-scripts`. The CLI does all the
reading and writing; never write the generated files (`scripts/btp*.js`, `ui5-btp-*.yaml`, `.env.*`…) by hand.

Run it as:

```sh
npx -y -p @scodigis/generator-btp-on-premise-scripts@0.7.2 btp-on-premise-setup <command> [options]
```

Below, `CLI` stands for that command. Every command prints JSON; a failure prints `{ "error": "..." }` and exits
non-zero. Quote option values that contain spaces. Requirements: Node.js 22+ and the cf CLI in `PATH`.

Use AskUserQuestion whenever the user has to pick from a list (region, org, space, app, destination) and offer
the values the CLI returned, with the default first. Skip a question when there is only one valid answer, and
say what you picked.

## When it is not needed

If the SAP system is reachable directly from the user's machine (no Cloud Connector), they do not need this:
point them to the Service Center of SAP Fiori tools instead. Mention this once at the start.

## Steps

### 1. Project and environment

1. Find the app: the folder with `package.json`, `ui5.yaml` and `webapp/manifest.json`, or a SAPUI5 library
   (`ui5.yaml` with `type: library`). Usually the current working directory; otherwise ask.
2. `CLI inspect --project <dir>` - shows the app kind, the environments already set up (`environments`) and,
   for the first of them (or `dev`), the existing values and defaults. On `error`, `candidates` lists app
   folders found underneath; ask which one.
3. Ask for the environment name (`dev`, `qual`, `prod`…: letters, digits, `-`, `_`). An existing name changes
   that environment; a new one adds another. If it differs from the `env` of the previous call, run
   `CLI inspect --project <dir> --env <name>` again to get its values.
4. If `hasBuildScript` is false, warn that `deploy-btp` needs a `build` script in `package.json`.
5. If `library` is true, the project is a SAPUI5 library: there is nothing to run, it is only deployed. Skip the
   runtime destination (step 4.2 and 4.3) and ask only for the deploy destination; it gets `deploy-btp:<env>`,
   `deploy-btp-test:<env>` and `btp-proxy:<env>`, no `start-btp:<env>`. A hand-written `deploy-btp` script that
   expects someone else's proxy to be running can be replaced by `deploy-btp:<env>`, which starts its own.

### 2. Cloud Foundry login

1. `CLI status`.
2. If `loggedIn` is true and the environment has no `existing.BTP_CF_API` or the same one as `api`, ask whether
   to use the current session (show `api` and `user`) or log in to another region / subaccount.
3. To log in: find the API endpoint. Default is `existing.BTP_CF_API`, else the current `api`. To let the user
   choose, `CLI regions` lists the regions (`key`, `location`, `provider`, `api`); the user can also give an
   endpoint from the subaccount overview in the BTP cockpit.
   - Single sign-on (default): `CLI login-url --api <api>` and give the user `passcodeUrl`. When they paste the
     one-time passcode: `CLI login --api <api> --passcode <code>`. Remember that SSO was used (`--sso` in step 6).
   - User and password: do not ask for the password in the chat. Ask the user to run `cf login -a <api>` in their
     own terminal (add `--origin <origin>` for a custom identity provider), then run `CLI status` again.
     Use `--no-sso` in step 6.
   - If the session was kept as is, pass neither flag: the environment keeps what it had.

### 3. Org, space and tunnel app

1. `CLI orgs`, then `CLI spaces --org <org>`. Defaults: `existing.BTP_CF_ORG` / `BTP_CF_SPACE`, then the
   current target from `status`.
2. `CLI apps --org <org> --space <space>` lists the apps bound to both a destination and a connectivity
   instance. Use `existing.BTP_APP` if it is listed; pick automatically when there is exactly one; ask when there
   are several.
3. If the chosen app has `sshEnabled: false`, tell the user to run `cf enable-ssh <app>` and `cf restart <app>`
   (or do it for them if they agree). If SSH is disabled for the whole space, a Space Manager has to run
   `cf allow-space-ssh <space>`.
4. If there is no app: explain that the proxy needs one, and offer to create `btp-tunnel` (a 64 MB app that only
   sleeps; it reuses or creates the `destination` and `connectivity` service instances with plan `lite`). This
   changes the user's BTP space, so get an explicit yes, then `CLI create-tunnel --org <org> --space <space>`
   (it takes a minute or two). If it fails on entitlements or quota, relay the message: the subaccount needs the
   entitlements Destination (lite), Connectivity (lite) and 64 MB of Cloud Foundry Runtime memory.

### 4. Destinations

1. `CLI destinations --org <org> --space <space> --app <app>` lists the OnPremise HTTP destinations with `Name`,
   `URL`, `sap-client`, `Authentication` and `supported`. Only those with `supported: true`
   (`NoAuthentication` or `BasicAuthentication`) work, because the local proxy has no user token. Credentials
   are never returned.
2. Ask for the runtime destination (`npm run start-btp:<env>`; not for a library). Default: `existing.BTP_DESTINATION`, then one of
   `runtimeDestinations` from `inspect`, then `deployDefaults.destination`.
3. Ask whether the app should also be deployed through a BTP destination (default yes, unless the environment
   already exists without `BTP_DEPLOY_DESTINATION`). If yes, ask for the deploy destination (default:
   `existing.BTP_DEPLOY_DESTINATION`, then `deployDefaults.destination`, then the runtime destination).
4. If none is listed, the subaccount has no OnPremise destination the app can see: they are defined in the BTP
   cockpit (Connectivity > Destinations) and need a connected Cloud Connector.

### 5. Deployment (only with a deploy destination)

Defaults come from `deployDefaults` of `inspect`. Ask for, or confirm:

- BSP application name (`--bsp`): up to 15 characters, letters, digits, `_`, optional `/NAMESPACE/`;
- package (`--package`);
- transport request (`--transport`): required unless the package starts with `$` (local, e.g. `$TMP`);
- client (`--client`): three digits; default the destination's `sap-client`, then `deployDefaults.client`.

If the deploy destination has `NoAuthentication`, the upload needs an ABAP user: ask for the user name
(`--deploy-user`). Do not ask for the password in the chat. After step 6 the user enters it in `.env.<env>`
(`SAP_PWD=`) themselves. If the environment already has one (`existing.SAP_PWD` is `***`), it is kept.

### 6. Write

1. Run `apply` with `--dry-run` first and show the user which files it would write or remove:

   ```sh
   CLI apply --project <dir> --env <env> --org <org> --space <space> --app <app> --destination <runtime> \
     [--deploy-destination <deploy> --bsp <name> --package <pkg> [--transport <tr>] [--client <nnn>] [--deploy-user <user>]] \
     [--sso | --no-sso] --dry-run
   ```

   For a library, leave out `--destination` and pass `--deploy-destination` with the deployment options.

2. On the user's go-ahead, run the same command without `--dry-run`. It writes the files, adds `.env` and
   `.env.<env>` to `.gitignore`, and runs `cf target` on the org and space.
3. Report the `scripts` it returns and any `warnings`, for example:
   - `npm run start-btp:<env>`: runs the app through the runtime destination (also in VS Code as the run
     configuration "Run with BTP destination (<env>)");
   - `npm run deploy-btp:<env>` / `deploy-btp-test:<env>`: build and deploy, or test mode;
   - `npm run btp-proxy:<env>`: only the proxy.

   Note that `npm start` and the Fiori tools Run / Preview still use `ui5.yaml`, and that the scripts log in to
   Cloud Foundry themselves (in the terminal) when the session has expired.

## Several environments

Each run sets up one environment, with its own API endpoint, org, space, app, destinations and ports. To add
`qual` or `prod`, go through the steps again with the new name. Environments on different API endpoints cannot
be started at the same moment (the scripts switch the global cf target): start one, wait until its proxy is up,
then start the other.

## Troubleshooting

- `npx` fails or is slow: the user can install once with
  `npm install -g @scodigis/generator-btp-on-premise-scripts` and you call `btp-on-premise-setup` directly.
- "The cf CLI was not found in PATH": install it from https://github.com/cloudfoundry/cli.
- The token expired during the steps: log in again (step 2) and repeat the failed command.
- More details and the manual first-time setup:
  https://github.com/DenisGalandSAP/generator-btp-on-premise-scripts#readme
