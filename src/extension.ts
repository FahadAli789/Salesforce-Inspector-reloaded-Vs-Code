import * as vscode from 'vscode';
import { SfdxService } from './sfdxService';
import { LocalServer } from './localServer';

// ... imports ...

export function activate(context: vscode.ExtensionContext) {


    const provider = new InspectorViewProvider(context.extensionUri, context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('salesforce-inspector.view', provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('salesforce-inspector.openInspector', () => {
             vscode.commands.executeCommand('salesforce-inspector.view.focus');
        })
    );
    
    // Start server logic
    const server = new LocalServer(context);
    server.start().then(async (url) => {

        const externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(url));
        const finalUrl = externalUri.toString().replace(/\/$/, ''); 

        
        context.workspaceState.update('inspectorServerUrl', finalUrl);
        // Refresh the view if it's already visible
        provider.refresh();
    }).catch(err => {
        console.error('Failed to start server:', err);
        vscode.window.showErrorMessage('Failed to start Salesforce Inspector Server: ' + err.message);
    });
}

class InspectorViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {}

    public refresh() {
        if (this._view) {
            this._getHtmlForWebview(this._view.webview).then(html => {
                this._view!.webview.html = html;
            });
        }
    }

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = await this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (message) => {
             // ... message handling ...
             switch (message.command) {
                // ... existing cases ...
                case 'openExternal':
                    if (message.url) {

                        const target = vscode.Uri.parse(message.url);
                        vscode.env.openExternal(target).then(success => {
                            if (!success) {
                                console.error('[ExtensionHost] Failed to open external URL:', message.url);
                            }
                        });
                    }
                    break;
                case 'openDataExport':
                    const baseUrl = this._context.workspaceState.get<string>('inspectorServerUrl');
                    if (baseUrl) {
                        const org = await SfdxService.getDefaultOrg();
                        const host = org ? org.instanceUrl.replace(/^https?:\/\//, '') : 'VSCodeProxy';
                        const target = vscode.Uri.parse(`${baseUrl}/data-export.html?host=${host}&proxy=true`);
                        vscode.env.openExternal(target);
                    } else {
                        vscode.window.showErrorMessage('Inspector Server not ready yet.');
                    }
                    break;
                case 'callApi':
                    // ... existing callApi logic ...
                    try {
                        const org = await SfdxService.getDefaultOrg();
                        if (!org) {
                            throw new Error('No default org found');
                        }

                        const response = await fetch(`${org.instanceUrl}${message.url}`, {
                            method: message.method || 'GET',
                            headers: {
                                'Authorization': `Bearer ${org.accessToken}`,
                                'Content-Type': 'application/json',
                                ...message.headers
                            },
                            body: message.body ? JSON.stringify(message.body) : undefined
                        });

                        const data = await response.json();
                        webviewView.webview.postMessage({
                            command: 'apiResponse',
                            requestId: message.requestId,
                            data: data,
                            status: response.status
                        });
                    } catch (error: any) {
                        webviewView.webview.postMessage({
                            command: 'apiResponse',
                            requestId: message.requestId,
                            error: error.message
                        });
                    }
                    break;
            }
        });
    }

    private async _getHtmlForWebview(webview: vscode.Webview) {
        // Get the local server URL from the workspace state
        const serverUrl = this._context.workspaceState.get<string>('inspectorServerUrl');

        if (!serverUrl) {
            return `<!DOCTYPE html>
            <html lang="en">
            <body style="font-family: sans-serif; padding: 20px;">
                <p>Initializing Salesforce Inspector Server...</p>
                <p>Please wait...</p>
            </body>
            </html>`;
        }

        const org = await SfdxService.getDefaultOrg();
        const hostParam = org ? org.instanceUrl.replace(/^https?:\/\//, '') : 'VSCodeProxy';
        const popupUrl = `${serverUrl}/popup.html?host=${hostParam}&proxy=true`;

        return `<!DOCTYPE html>
        <html lang="en" style="height: 100%; width: 100%;">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${serverUrl} http://localhost:*; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body, html { margin: 0; padding: 0; height: 100%; overflow: hidden; background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
                iframe { width: 100%; height: 100%; border: none; }
                #debug-bar { padding: 5px; background: #333; color: white; display: flex; justify-content: flex-end; font-size: 10px; }
                #debug-bar a { color: #4DAAF9; text-decoration: none; margin-left: 10px; cursor: pointer; }
            </style>
        </head>
        <body>
            <div id="debug-bar">
                <span>Server: ${serverUrl}</span>
                <a onclick="openExternal('${popupUrl}')">Open in Browser</a>
            </div>
            <iframe src="${popupUrl}" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox" onerror="console.error('Failed to load iframe')"></iframe>
            <script>

                const vscode = acquireVsCodeApi();
                
                function openExternal(url) {
                    vscode.postMessage({ command: 'openExternal', url: url });
                }

                // Forward messages from iframe to VS Code extension host
                const handleMessage = (event) => {

                    if (event.data && event.data.command) {
                        vscode.postMessage(event.data);
                    } else if (event.data) {
                        console.warn('[WebviewWrapper] Received message without command:', event.data);
                    }
                };

                window.addEventListener('message', handleMessage);
                // Backup handler
                window.onmessage = (e) => {

                };
            </script>
        </body>
        </html>`;
    }
}
