
import * as vscode from 'vscode';
import { SfdxService } from './sfdxService';

export class ProxyHelper {

    public static async handleApiRequest(message: any): Promise<any> {
        // Original logic from localServer.ts /api/proxy endpoint
        let org = await SfdxService.getDefaultOrg();
        if (!org) {
            throw new Error('No active Salesforce Connection found in VS Code.');
        }

        const { url, method, headers, body } = message;
        
        // Construct full URL
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
            // Ensure no double slashes if instanceUrl ends with / and target starts with /
            const baseUrl = org.instanceUrl.replace(/\/$/, '');
            const finalPath = targetPath.replace(/^\//, '');
            fullUrl = `${baseUrl}/${finalPath}`;
        }

        let originalBody = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
        // SOAP Handling: Check for injected dummy session ID
        const isSoapWithInjectedToken = originalBody && typeof originalBody === 'string' && originalBody.includes('dummy-session-id-handled-by-vscode');

        const prepareOptions = (token: string): RequestInit => {
            let reqBody = originalBody;
            if (isSoapWithInjectedToken && reqBody) {
                 reqBody = reqBody.replace('dummy-session-id-handled-by-vscode', token);
            }
            
            const fetchOptions: RequestInit = {
                method: method || 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    // Default to json if not specified, but respect input
                    'Content-Type': headers && headers['Content-Type'] ? headers['Content-Type'] : 'application/json',
                    ...headers
                },
                body: reqBody
            };

            if (isStatusApi) {
                // @ts-ignore
                delete fetchOptions.headers['Authorization'];
            }
            return fetchOptions;
        };

        const executeFetch = async (token: string, isRetry: boolean = false): Promise<any> => {
           console.log(`[ProxyHelper] Executing fetch: ${fullUrl} (method: ${method || 'GET'})`);
           
           const options = prepareOptions(token);
           const response = await fetch(fullUrl, options);
           
           console.log(`[ProxyHelper] Response status: ${response.status} for ${fullUrl}`);

           if (response.status === 401 && !isRetry && !isStatusApi) {
                console.log('[ProxyHelper] 401 received, attempting token refresh...');
                // Refresh logic
                const newOrg = await SfdxService.getDefaultOrg(true);
                if (newOrg) {
                    return executeFetch(newOrg.accessToken, true);
                }
           }

           // Handle Response
           const contentType = response.headers.get('content-type');
           if (response.status === 204) {
               return { status: 204, body: null };
           }

           const text = await response.text();
           let resultBody = text;
           try {
               if (contentType && contentType.includes('application/json') && text.trim().length > 0) {
                   resultBody = JSON.parse(text);
               }
           } catch (e) {
               // keep as text
           }

           if (!response.ok) {
               // Return error structure that inspector.js expects
               // It expects the fetch to throw or return a response that can be .json()'d
               // We will return a structured object that the extension.ts handler will pass back
               return {
                   status: response.status,
                   statusText: response.statusText,
                   body: resultBody,
                   contentType: contentType,
                   error: true
               };
           }

           return {
               status: response.status,
               body: resultBody,
               contentType: contentType
           };
        };

        return executeFetch(org.accessToken);
    }

    public static async handleCometdRequest(message: any): Promise<any> {
        let org = await SfdxService.getDefaultOrg();
        if (!org) {
             throw new Error('No active Salesforce Connection found in VS Code.');
        }
        
        // CometD URL is usually passed in message.url which is relative like /cometd/50.0
        const fullUrl = `${org.instanceUrl}${message.url}`;

        const makeRequest = async (accessToken: string) => {
             return fetch(fullUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(message.body)
            });
        };

        let response = await makeRequest(org.accessToken);

        if (response.status === 401) {
            org = await SfdxService.getDefaultOrg(true);
            if (org) {
                response = await makeRequest(org.accessToken);
            }
        }

        if (response.status === 204) {
             return { status: 204 };
        }
        
        const text = await response.text();
        return {
            status: response.status,
            body: text // CometD usually expects text/json
        };
    }
}
