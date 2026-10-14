import * as http from 'http';
import * as https from 'https';

/** Where GitHub's API is. A parameter so that tests can stand in for it. */
export interface GitHubApi { protocol: 'https:' | 'http:'; host: string; port?: number }
export const GITHUB: GitHubApi = { protocol: 'https:', host: 'api.github.com' };

export interface ApiAnswer { status: number; json: unknown }

export function githubRequest(api: GitHubApi, method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<ApiAnswer> {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const request = (api.protocol === 'https:' ? https : http).request({
            protocol: api.protocol, hostname: api.host, port: api.port, method, path, timeout: 20_000,
            headers: {
                'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Codico',
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
        }, response => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => {
                let json: unknown;
                try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { json = null; }
                resolve({ status: response.statusCode ?? 0, json });
            });
        });
        request.on('error', reject);
        request.on('timeout', () => request.destroy(new Error('GitHub did not answer in time')));
        request.end(payload);
    });
}
