# BTP On-Premise Access

Adds **SAP BTP: Generate BTP On-Premise Destination Scripts** to the Command Palette (`Ctrl+Shift+P`).
It opens the [@scodigis/generator-btp-on-premise-scripts](https://www.npmjs.com/package/@scodigis/generator-btp-on-premise-scripts)
generator in the Template Wizard, with the Fiori app of the open workspace preselected.

Needs the Template Wizard extension (`SAPOS.yeoman-ui`, part of the SAP Fiori tools extension pack). When the
generator is not installed yet, the Template Wizard offers to install it.

## Build and install

```sh
npm run package                                   # creates btp-on-premise-access-<version>.vsix
code --install-extension btp-on-premise-access-0.4.3.vsix
```
