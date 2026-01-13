import * as cp from 'child_process';
import * as vscode from 'vscode';

export interface SalesforceOrg {
    accessToken: string;
    instanceUrl: string;
    alias?: string;
    username: string;
}

export class SfdxService {
    private static cachedOrg: SalesforceOrg | undefined;
    private static lastCacheTime: number = 0;
    private static readonly CACHE_DURATION_MS = 60 * 1000 * 60; // 1 hour cache (relying on 401 retry to refresh)

    public static async getDefaultOrg(forceRefresh: boolean = false): Promise<SalesforceOrg | undefined> {
        const now = Date.now();
        if (!forceRefresh && this.cachedOrg && (now - this.lastCacheTime < this.CACHE_DURATION_MS)) {
            return this.cachedOrg;
        }

        return new Promise((resolve, reject) => {
            // Get the default username/alias from the workspace config or default
            // For now, we use 'sf org display --json' which shows the default org
            cp.exec('sf org display --json', (error, stdout, stderr) => {
                if (error) {
                    console.error(`Error executing sf command: ${error}`);
                    // Fallback to sfdx for older setups
                    cp.exec('sfdx org display --json', (error2, stdout2, stderr2) => {
                        if (error2) {
                            resolve(undefined);
                        } else {
                            this.updateCache(this.parseResponse(stdout2));
                            resolve(this.cachedOrg);
                        }
                    });
                    return;
                }
                this.updateCache(this.parseResponse(stdout));
                resolve(this.cachedOrg);
            });
        });
    }

    private static updateCache(org: SalesforceOrg | undefined) {
        if (org) {
            this.cachedOrg = org;
            this.lastCacheTime = Date.now();
        }
    }

    private static parseResponse(stdout: string): SalesforceOrg | undefined {
        try {
            // Find the start of the JSON object, skipping any warnings or other text
            const startIndex = stdout.indexOf('{');
            if (startIndex === -1) {
                console.error('No JSON found in SFDX response');
                return undefined;
            }
            const jsonContent = stdout.substring(startIndex);
            const response = JSON.parse(jsonContent);
            if (response.status === 0) {
                const data = response.result;
                return {
                    accessToken: data.accessToken,
                    instanceUrl: data.instanceUrl,
                    alias: data.alias,
                    username: data.username
                };
            }
        } catch (e) {
            console.error('Failed to parse SFDX response. Raw stdout:', stdout, e);
        }
        return undefined;
    }
}
