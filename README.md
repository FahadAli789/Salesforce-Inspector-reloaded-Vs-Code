# Salesforce Inspector Reloaded for VS Code

A port of the popular [Salesforce Inspector Reloaded](https://github.com/tprouvot/Salesforce-Inspector-reloaded) browser extension, now available directly within Visual Studio Code!

## Features

- **Data Export**: Query your Salesforce data using SOQL/SOSL with a powerful editor.
- **Data Import**: Easily upload data to Salesforce.
- **Org Limits**: View current limits for your Salesforce Org.
- **API Exploration**: interact with Salesforce APIs directly.
- **Code Builder Compatible**: Works seamlessly in local VS Code and cloud environments like Salesforce Code Builder and GitHub Codespaces.

## Usage

1. **Connect to an Org**: ensure you have a default Org authorized via the Salesforce CLI (`sf` or `sfdx`).
   ```bash
   sf org login web -a my-org
   sf config set target-org=my-org
   ```
2. **Open Inspector**:
   - Click the Salesforce Inspector icon in the Activity Bar (left sidebar).
   - Or run the command `Salesforce Inspector: Open` from the Command Palette (`Cmd+Shift+P`).

## connection Security

This extension uses a local proxy server to securely route requests to Salesforce, ensuring compatibility with VS Code's webviews and cloud environments. It leverages your existing Salesforce CLI authentication session.

## Credits

This is a VS Code port of the amazing work done by the Salesforce Inspector Reloaded team.
