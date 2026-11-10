# ABAP Development Tools for VS Code in SAP Business Application Studio

This guide connects ABAP Development Tools (ADT) for VS Code, running in an SAP Business Application Studio dev
space, to an on-premise ABAP system behind a Cloud Connector.

ADT talks to a small proxy in your dev space (`https://127.0.0.1:5443`). The proxy goes through a
`cf ssh` tunnel to the Connectivity service, then through the Cloud Connector to the system:

```
ADT (dev space) -> btp-proxy.js (127.0.0.1:5443) -> cf ssh tunnel (tunnel app) -> Connectivity service
               -> Cloud Connector -> ABAP system (/sap/bc/adt)
```

You log on to the ABAP system as yourself, with your own ABAP user.

In the commands below, replace the words in CAPITALS (`YOUR_ORG`, `YOUR_SPACE`...) with your values. Leave out any
angle brackets: in a terminal, `<` and `>` redirect input and output.

## 1. Before you start

Ask whoever runs the subaccount for:

| What | Example | Why |
|---|---|---|
| Cloud Foundry API, org and space | `https://api.cf.eu10.hana.ondemand.com`, `my-org`, `dev` | where the tunnel app runs |
| The Space Developer role in that space, for your cf user | | `cf ssh` needs it |
| The name of the tunnel app | `btp-tunnel` | the proxy tunnels through it ([First-time setup](../README.md#first-time-setup)) |
| A destination to the ABAP system with NoAuthentication | `S4HCLNT100` | so the proxy logs on with your own user |
| Your ABAP user and password, and the client | `100` | your logon |

The Cloud Connector must expose `/sap/bc/adt` for the system.

Use a destination with NoAuthentication. With a BasicAuthentication destination, the proxy logs on with the
user stored in the destination. Everything you do in ADT, including locks and transport entries, is then
recorded under that user's name. Principal propagation destinations don't work through the proxy.

## 2. Dev space and ADT

1. In SAP Business Application Studio, create a dev space (any type, for example *Full Stack Cloud Application*),
   start it and open it.
2. **File > Open Folder** > `/home/user/projects`.
3. In the **Extensions** view (Ctrl+Shift+X), search for **ABAP Development Tools** (publisher SAP, id
   `sapse.adt-vscode`) and install it. If it doesn't show up, download the Linux x64 VSIX from the extension's page
   on the Visual Studio Marketplace, then in the Extensions view use **...** > **Install from VSIX...**.

## 3. Log in to Cloud Foundry and check the tunnel

Open a terminal (**Terminal > New Terminal**):

```bash
cf login -a YOUR_CF_API -o YOUR_ORG -s YOUR_SPACE
cf ssh YOUR_TUNNEL_APP -c "echo ok"
```

The second command must print `ok`. If it fails with a permission error, you don't have Space Developer in the
space. If it hangs, the dev space can't open ssh connections, and this setup won't work from it.

## 4. Set up the folder

Pick one of the two routes. Both write the same files into `~/projects/adt`.

### Route A: the Template Wizard

The dev space already has the Template Wizard. Install the generator once:

```bash
npm install -g @scodigis/generator-btp-on-premise-scripts
```

Then press F1, run **Open Template Wizard**, and pick the **BTP On-Premise Access** tile. In the wizard:

1. **Project**: choose *ABAP development*, and as the folder `/home/user/projects/adt` (create it first with
   `mkdir -p ~/projects/adt`). Give the environment a name, for example the system and client: `s4h-100`.
2. **Cloud Foundry**: you are already logged in from step 3; pick the org, the space and the tunnel app.
3. **Destinations**: pick the NoAuthentication destination. The hint under it should say that ADT logs on as
   you.
4. Finish. The last page lists the next commands.

### Route B: one command, nothing to install

```bash
mkdir -p ~/projects/adt && cd ~/projects/adt
npx -y -p @scodigis/generator-btp-on-premise-scripts btp-on-premise-setup apply --abap \
  --project . --env YOUR_ENV --org YOUR_ORG --space YOUR_SPACE \
  --app YOUR_TUNNEL_APP --destination YOUR_DESTINATION --cf-user YOUR_CF_EMAIL --no-sso
```

`YOUR_ENV` is a short name for this system and client, for example `s4h-100`. The command prints JSON ending with
`"warnings": []`.

Either route creates:

```
~/projects/adt/
  .env.YOUR_ENV        settings only: cf org and space, tunnel app, destination, ports (no password)
  package.json         npm run btp-proxy:YOUR_ENV
  scripts/btp-proxy.js the proxy
  scripts/btp-env.js
  scripts/btp-mcp.js   for an ADT MCP server, optional
  .vscode/tasks.json   the "BTP proxy YOUR_ENV" task that starts the proxy (step 6)
```

## 5. Trust the proxy's certificate

ADT only connects over https, and its own Java runtime has to trust the proxy's localhost certificate:

```bash
npx -y -p @scodigis/generator-btp-on-premise-scripts btp-on-premise-setup adt-cert
```

It creates `~/.config/btp-proxy/localhost.crt` and lists the ADT Java runtime it imported it into. If the list is
empty, ADT isn't installed yet (step 2). Then press F1 and run **Developer: Reload Window**.

Run this again after every ADT update: an update replaces ADT's Java runtime, and with it the trusted
certificates.

## 6. Start the proxy

Each time you work: press F1, run **Tasks: Run Task**, and pick **BTP proxy YOUR_ENV**. It asks for your ABAP
user, then your password (masked); neither is saved. The proxy opens in its own terminal panel.

From a terminal instead:

```bash
cd ~/projects/adt
read -rp 'ABAP user: ' BTP_PROXY_USER; read -rsp 'Password: ' BTP_PROXY_PWD; echo
export BTP_PROXY_USER BTP_PROXY_PWD
npm run btp-proxy:YOUR_ENV
```

The password isn't shown and isn't written anywhere. Wait for `listening on https://127.0.0.1:5443` and keep the
terminal open. If your cf session has expired, run `cf login` first (step 3).

## 7. Connect ADT

The first time:

1. Press F1 and run **ABAP: Add System** (or **+** in the ABAP explorer). Choose an HTTP (URL) system.
2. URL `https://127.0.0.1:5443`, your client, any name.
3. When ADT asks how to log on, choose **Open with Default Browser**. A browser tab opens, ends on an "ADT Logon"
   page, and the system appears in the explorer.

ADT asks for this browser logon again when its session expires.

## Several clients or systems

Set up one environment per client, in the same folder: run route A or B of step 4 once per destination, each
time with its own environment name. For example, for clients 100 and 300 of a system S4H:

```bash
cd ~/projects/adt
for e in "s4h-100 S4HCLNT100" "s4h-300 S4HCLNT300"; do set -- $e
  npx -y -p @scodigis/generator-btp-on-premise-scripts btp-on-premise-setup apply --abap \
    --project . --env $1 --org YOUR_ORG --space YOUR_SPACE \
    --app YOUR_TUNNEL_APP --destination $2 --cf-user YOUR_CF_EMAIL --no-sso
done
```

Each environment gets its own ports. The first one keeps 5050 and 5443, and the next ones get the next free pair
(5052 and 5445 here). `grep PORT .env.*` shows them. Start each proxy with its own task (step 6: "BTP proxy s4h-100" and
"BTP proxy s4h-300"), and add one system per client in ADT (step 7), each
with its own https port: `https://127.0.0.1:5443` for client 100, `https://127.0.0.1:5445` for client 300.

The certificate (step 5) is the same for all of them.

## Troubleshooting

| What you see | What to do |
|---|---|
| `<- 401` lines in the proxy terminal | Wrong ABAP password. Press Ctrl+C at once and start again (step 6): every attempt counts as a failed logon, and a few more lock your user. |
| "PKIX path building failed" in ADT | The certificate isn't trusted: run step 5 again, then **Developer: Reload Window**. |
| "Logon has failed" right after the browser tab | The proxy isn't going through the tunnel. The proxy's first lines must show `opening ssh tunnel`. Check that `.env.YOUR_ENV` has `BTP_APP` set. |
| The browser tab can't open the logon callback | Start the logon again from ADT with **Open with Default Browser**, not by copying the URL into a browser. |
| ADT hangs; its error log says "destination service was not initialized yet" | See below. |
| `listen EADDRINUSE` when starting the proxy | A proxy is already running: `pkill -f btp-proxy.js`, then start it again. |

If ADT hangs at startup after a failed first connection, stop its language server, move its workspace aside and
add the system again:

```bash
pkill -f adt-ls/linux
W=$(ls -d ~/.vscode/data/User/workspaceStorage/*/SAPSE.adt-vscode/adtWorkspace)
mv "$W" "$W.bak"; mv ~/.adtls ~/.adtls.bak
```

Then **Developer: Reload Window**, and step 7.

ADT's own logs are in `~/.vscode/data/logs/*/exthost*/SAPSE.adt-vscode/`, and its language server writes startup
errors to `adtWorkspace/.metadata/.log` in the folder above.

## Why the dev space's own destinations aren't used

A dev space can reach destinations without cf (`http://DESTINATION.dest`), and the proxy can use that route
(`--bas`). That route drops the system's session cookies, which ADT needs: the logon gets through, then fails with
"Logon has failed".
