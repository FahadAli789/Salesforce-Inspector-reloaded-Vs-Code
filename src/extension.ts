import * as vscode from 'vscode';
import { SfdxService } from './sfdxService';
import { ProxyHelper } from './proxyHelper';
import * as path from 'path';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {

    // Helper to manage webview logic
    const manager = new InspectorManager(context.extensionUri, context);

    // Sidebar Provider
    const provider = new InspectorViewProvider(manager);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('salesforce-inspector.view', provider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    // Command: Open in Sidebar
    context.subscriptions.push(
        vscode.commands.registerCommand('salesforce-inspector.openInspector', () => {
             vscode.commands.executeCommand('salesforce-inspector.view.focus');
        })
    );

    // Command: Open in Tab
    context.subscriptions.push(
        vscode.commands.registerCommand('salesforce-inspector.openInspectorTab', async () => {
             const panel = vscode.window.createWebviewPanel(
                 'salesforceInspector',
                 'Salesforce Inspector',
                 vscode.ViewColumn.One,
                 {
                     enableScripts: true,
                     retainContextWhenHidden: true,
                     localResourceRoots: [context.extensionUri]
                 }
             );
             await manager.setupWebview(panel.webview);
        })
    );
}

class InspectorManager {
    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {}

    public async setupWebview(webview: vscode.Webview) {
        webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        // Initial Load
        const org = await SfdxService.getDefaultOrg();
        const host = org ? org.instanceUrl.replace(/^https?:\/\//, '') : 'VSCodeProxy';
        await this._loadPage(webview, `popup.html?host=${host}&proxy=true`);

        // Message Handling
        webview.onDidReceiveMessage(async (message) => {
             switch (message.command) {
                case 'insextLoaded':
                    break;
                case 'openExternal':
                    if (message.url) {
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                    }
                    break;
                case 'navigate':
                     if (message.path) {
                         await this._loadPage(webview, message.path);
                     }
                     break;
                case 'openInTab':
                     if (message.path) {
                         console.log('[InspectorManager] openInTab received with path:', message.path);
                         
                         // Determine Title based on file name
                         let title = 'Inspector';
                         if (message.path.includes('data-export')) title = 'Data Export';
                         else if (message.path.includes('data-import')) title = 'Data Import';
                         else if (message.path.includes('limits')) title = 'Org Limits';
                         else if (message.path.includes('meta-retrieve')) title = 'Metadata Retrieve';
                         else if (message.path.includes('explore-api')) title = 'Explore API';
                         else if (message.path.includes('event-monitor')) title = 'Event Monitor';
                         else if (message.path.includes('inspect')) title = 'Show All Data';

                         const panel = vscode.window.createWebviewPanel(
                             'salesforceInspectorTab',
                             title,
                             vscode.ViewColumn.One,
                             {
                                 enableScripts: true,
                                 retainContextWhenHidden: true,
                                 localResourceRoots: [this._extensionUri]
                             }
                         );
                         // Need to spin up a new manager/message handler for this panel?
                         // Actually, we can just use the RECURSIVE manager logic on this new webview.
                         // But we need to use 'self' or similar, so let's stick to using 'this.setupWebview'
                         // which binds the messages to *that specific webview*.
                         await this.setupWebview(panel.webview);
                         
                         // Load the requested page
                         console.log('[InspectorManager] Loading page with path:', message.path);
                         await this._loadPage(panel.webview, message.path);

                         // Focus the new tab (panel) which implicitly hides sidebar focus.
                         // User requested to "Hide extension back" - actually closing the sidebarView:
                         // We can execute `workbench.action.closeSidebar`
                         vscode.commands.executeCommand('workbench.action.closeSidebar');
                     }
                     break;
                case 'logError':
                     console.error(`[Webview Error] ${message.message}`, message.stack || '');
                     break;
                case 'settingsUpdate':
                    const settings: any = this._context.globalState.get('inspectorSettings') || {};
                    if (message.value === null) {
                        delete settings[message.key];
                    } else {
                        settings[message.key] = message.value;
                    }
                    this._context.globalState.update('inspectorSettings', settings);
                    break;
                case 'settingsClear':
                    this._context.globalState.update('inspectorSettings', {});
                    break;
                case 'callApi':
                    try {
                        const result = await ProxyHelper.handleApiRequest(message);
                        webview.postMessage({
                            command: 'apiResponse',
                            requestId: message.requestId,
                            data: result
                        });
                    } catch (error: any) {
                         webview.postMessage({
                            command: 'apiResponse',
                            requestId: message.requestId,
                            isError: true,
                            error: error.message
                        });
                    }
                    break;
                case 'cometd':
                    try {
                        const result = await ProxyHelper.handleCometdRequest(message);
                        webview.postMessage({
                            command: 'apiResponse', // We use same response channel
                            requestId: message.requestId,
                            data: result
                        });
                    } catch (error: any) {
                         webview.postMessage({
                            command: 'apiResponse',
                            requestId: message.requestId,
                            isError: true,
                            error: error.message
                        });
                    }
                    break;
            }
        });
    }

    private async _loadPage(webview: vscode.Webview, relativePath: string = 'popup.html') {
        console.log('[_loadPage] Called with relativePath:', relativePath);
        
        // Parse path and query
        const parts = relativePath.split('?');
        const fileName = parts[0];
        const query = parts[1] || '';
        
        console.log('[_loadPage] Parsed - fileName:', fileName, 'query:', query);

        // Read file
        const filePath = path.join(this._context.extensionPath, 'media', fileName);
        if (!fs.existsSync(filePath)) {
            console.error('File not found:', filePath);
            return;
        }
        let htmlContent = fs.readFileSync(filePath, 'utf8');

        // Setup paths
        const mediaUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media'));
        const nonce = getNonce();
        
        // Inject Base URI for relative links
        const baseTag = `<base href="${mediaUri}/">`;
        
        // Content Security Policy
        // Allows scripts from key sources: 'self', the webview csp source, and our random nonce for inline scripts.
        const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource} 'unsafe-eval'; img-src ${webview.cspSource} data:; connect-src ${webview.cspSource} https:;">`;

        htmlContent = htmlContent.replace('<head>', `<head>\n    ${baseTag}\n    ${cspMeta}`);

        // Inject Config Script + Shim
        const shimUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode-shim.js'));
        const settingsShimUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'settings-shim.js'));
        
        // Need host for init script interpolation
        let host = '';
        if (query.includes('host=')) {
           const match = query.match(/host=([^&]+)/);
           if (match) host = match[1];
        } else {
           // Fallback: Use default org if no host provided in link
           const org = await SfdxService.getDefaultOrg();
           if (org) {
               host = org.instanceUrl.replace(/^https?:\/\//, '');
               // Also enforce proxy param if missing
               if (!query.includes('proxy=')) {
                   // We won't modify 'query' var here as it's used for URL spoofing 
                   // but we ensure __initialHost and settings are correct.
               }
           }
        }

        // Get Settings
        const inspectorSettings = this._context.globalState.get('inspectorSettings') || {};
        const settingsJson = JSON.stringify(inspectorSettings);

        // Escape the query string for safe injection into JavaScript
        const escapedQuery = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

        const initScript = `
        <script nonce="${nonce}">
            window.__initialSettings = ${settingsJson};
            window.__initialHost = '${host}';
            // Inject query string as global variable since history.replaceState doesn't work in webviews
            window.__queryString = '${escapedQuery}';
            console.log('[InitScript] Injected __queryString:', window.__queryString);
            console.log('[InitScript] Injected __initialHost:', window.__initialHost);
        </script>
        <script src="${shimUri}"></script>
        <script src="${settingsShimUri}"></script>
        `;

        // Inject at the start of head so it runs before popup.js (which is a module)
        htmlContent = htmlContent.replace('<head>', `<head>
        <style>body { zoom: 0.85; overflow-x: hidden; }</style>
${initScript}`);

        webview.html = htmlContent;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

class InspectorViewProvider implements vscode.WebviewViewProvider {
    constructor(private readonly _manager: InspectorManager) {}

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        await this._manager.setupWebview(webviewView.webview);
    }
}
