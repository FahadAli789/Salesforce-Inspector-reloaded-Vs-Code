import * as vscode from 'vscode';
import express from 'express';
import * as http from 'http';
import cors from 'cors';
import * as bodyParser from 'body-parser';
import * as path from 'path';
import * as fs from 'fs';
import { SfdxService } from './sfdxService';

export class LocalServer {
    private app: express.Express;
    private server: http.Server | undefined;
    private port: number = 0; // 0 let the OS assign a random port

    constructor(private context: vscode.ExtensionContext) {
        this.app = express();
        this.app.use(cors());
        this.app.use(bodyParser.json());

        // Settings Endpoints - Store in VS Code globalState
        this.app.get('/settings', (req, res) => {
            const settings = this.context.globalState.get('inspectorSettings') || {};
            res.json(settings);
        });

        this.app.post('/settings', (req, res) => {
            const { key, value } = req.body;
            const settings: any = this.context.globalState.get('inspectorSettings') || {};
            if (value === null) {
                delete settings[key];
            } else {
                settings[key] = value;
            }
            this.context.globalState.update('inspectorSettings', settings).then(() => {
                res.sendStatus(200);
            });
        });

        this.app.post('/settings/clear', (req, res) => {
            this.context.globalState.update('inspectorSettings', {}).then(() => {
                res.sendStatus(200);
            });
        });

        // Inject settings shim into all HTML files to sync localStorage
        this.app.use((req, res, next) => {
            if (req.method === 'GET' && req.path.endsWith('.html')) {
                // Decode URI component to handle spaces in paths (e.g. "Salesforce Inspector Reloaded Port")
                // req.path is URL encoded. 
                const safePath = decodeURIComponent(req.path);
                const filePath = path.join(context.extensionPath, 'media', safePath);
                
                if (fs.existsSync(filePath)) {
                    try {
                        let content = fs.readFileSync(filePath, 'utf8');
                        // Inject script at the beginning of head
                        // We use a regex to be more robust
                        if (content.includes('<head>')) {
                             content = content.replace('<head>', '<head>\n    <script src="settings-shim.js"></script>');
                        } else {
                             // Fallback for files without head (unlikely but possible)
                             content = '<script src="settings-shim.js"></script>' + content;
                        }
                        res.setHeader('Content-Type', 'text/html');
                        res.send(content);
                        return;
                    } catch (e) {
                        console.error('Error injecting settings shim:', e);
                    }
                }
            }
            next();
        });

        // Serve static files from the 'media' directory (which contains the 'addon' folder content)
        const mediaPath = path.join(context.extensionPath, 'media');
        this.app.use(express.static(mediaPath));

        // Helper to handle retries on 401
        const fetchWithRetry = async (url: string, options: RequestInit, isRetry: boolean = false): Promise<Response> => {
            const response = await fetch(url, options);
            if (response.status === 401 && !isRetry) {

                const org = await SfdxService.getDefaultOrg(true);
                if (org) {
                    // Update Authorization header
                    const headers = options.headers as Record<string, string>;
                    if (headers['Authorization']) {
                         headers['Authorization'] = `Bearer ${org.accessToken}`;
                    }
                    // If it was a SOAP call injecting token into body, we need to update body too.
                    // But here we might not easily know if we need to replace it again without reparsing.
                    // However, we handle the dummy-session-id replacement before calling this.
                    // If the Body contained the OLD token, we need to replace it with NEW token.
                    // But we don't have the old token handy here easily unless we extracted it.
                    // For simplicity, we assume Authorization header is the main auth mechanism for REST,
                    // and for SOAP with body injection, we might need a more complex retry strategy or just accept that SOAP with body injection needs the header too?
                    // actually, SOAP usually doesn't use Auth header if SessionHeader is in body.
                    // Let's retry only if we can update the Auth header OR if we can re-inject into body.
                    
                    // Re-inject for SOAP if body is string
                    if (typeof options.body === 'string' && options.body.includes('SessionHeader')) {
                         // This is tricky without parsing XML. 
                         // But we can try to assume the old token is invalid and we just want to proceed.
                         // For now, let's focus on updating the Authorization header which is used by our REST proxy
                         // and potentially SOAP if we passed it.
                    }
                    
                    return fetch(url, options);
                }
            }
            return response;
        };

        // Proxy CometD Endpoint
        this.app.post(/^\/cometd\/.*$/, async (req, res) => {
            try {
                let org = await SfdxService.getDefaultOrg();
                if (!org) {
                    res.status(401).send({ error: 'No active Salesforce Connection found in VS Code.' });
                    return;
                }

                const fullUrl = `${org.instanceUrl}${req.originalUrl}`;
                
                const makeRequest = async (accessToken: string) => {
                     return fetch(fullUrl, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${accessToken}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(req.body)
                    });
                };

                let response = await makeRequest(org.accessToken);

                if (response.status === 401) {

                    org = await SfdxService.getDefaultOrg(true);
                    if (org) {
                        response = await makeRequest(org.accessToken);
                    }
                }

                const contentType = response.headers.get('content-type');
                if (contentType) {
                  res.setHeader('Content-Type', contentType);
                }

                // Handle 204 No Content
                if (response.status === 204) {
                    res.status(204).send();
                    return;
                }

                const responseText = await response.text();
                res.status(response.status).send(responseText);

            } catch (error: any) {
                console.error('CometD Proxy Error:', error);
                res.status(500).send({ error: error.message });
            }
        });

        // Proxy API Endpoint
        this.app.post('/api/proxy', async (req, res) => {
            try {
                let org = await SfdxService.getDefaultOrg();
                if (!org) {
                    res.status(401).send({ error: 'No active Salesforce Connection found in VS Code.' });
                    return;
                }

                // Construct full URL
                const { url, method, headers, body } = req.body;
                
                let targetPath = url;
                let fullUrl = '';
                const isStatusApi = url.startsWith('https://api.status.salesforce.com');

                if (isStatusApi) {
                    fullUrl = url;
                } else {
                    if (url.startsWith('http')) {
                        try {
                            const urlObj = new URL(url);
                            targetPath = urlObj.pathname + urlObj.search;
                        } catch (e) { }
                    }
                    fullUrl = `${org.instanceUrl}${targetPath}`;
                }
                
                let originalBody = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
                const isSoapWithInjectedToken = originalBody && typeof originalBody === 'string' && originalBody.includes('dummy-session-id-handled-by-vscode');


                if (isSoapWithInjectedToken) {

                }

                const prepareOptions = (token: string): RequestInit => {
                    let reqBody = originalBody;
                    if (isSoapWithInjectedToken && reqBody) {
                         reqBody = reqBody.replace('dummy-session-id-handled-by-vscode', token);
                    }
                    
                    const fetchOptions: RequestInit = {
                        method: method || 'GET',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': headers['Content-Type'] || 'application/json',
                            ...headers
                        },
                        body: reqBody
                    };

                    if (isStatusApi) {
                        // @ts-ignore
                        delete fetchOptions.headers['Authorization'];
                    } else {

                    }
                    return fetchOptions;
                };

                const options = prepareOptions(org.accessToken);
                let response = await fetch(fullUrl, options);

                if (response.status === 401 && !isStatusApi) {

                     org = await SfdxService.getDefaultOrg(true);
                     if (org) {
                        // If it was SOAP with injected token, we need to re-inject the NEW token into the ORIGINAL body.
                        // Fortunately prepareOptions does exactly that using the original Body template.
                        response = await fetch(fullUrl, prepareOptions(org.accessToken));
                     }
                }
                
                const contentType = response.headers.get('content-type');
                
                // Forward the content-type header
                if (contentType) {
                    res.setHeader('Content-Type', contentType);
                }

                // Handle 204 No Content explicitly
                if (response.status === 204) {
                    res.status(204).send();
                    return;
                }

                // Handle response body based on content type
                const responseText = await response.text();
                
                try {
                    if (contentType && contentType.includes('application/json') && responseText.trim().length > 0) {
                         res.status(response.status).send(JSON.parse(responseText));
                    } else {
                         res.status(response.status).send(responseText);
                    }
                } catch (e) {
                    // Fallback to sending text if JSON parse fails despite header
                    res.status(response.status).send(responseText);
                }

            } catch (error: any) {
                console.error('Proxy Error:', error);
                res.status(500).send({ error: error.message });
            }
        });
        // Endpoint to open external URLs from the webview
        this.app.post('/open-external', async (req, res) => {
            const { url } = req.body;
            if (url) {

                try {
                    const success = await vscode.env.openExternal(vscode.Uri.parse(url));
                    if (success) {
                        res.sendStatus(200);
                    } else {
                        res.status(500).send('Failed to open URL');
                    }
                } catch (e: any) {
                    console.error('[LocalServer] Error opening external URL:', e);
                    res.status(500).send(e.message);
                }
            } else {
                res.status(400).send('Missing url parameter');
            }
        });
    }

    public async start(): Promise<string> {
        return new Promise((resolve, reject) => {
            this.server = this.app.listen(0, 'localhost', () => {
                const address = this.server?.address();
                if (address && typeof address !== 'string') {
                    this.port = address.port;
                    const url = `http://localhost:${this.port}`;

                    resolve(url);
                } else {
                    reject(new Error('Failed to start server'));
                }
            });
        });
    }

    public stop() {
        if (this.server) {
            this.server.close();
            this.server = undefined;
        }
    }
}
