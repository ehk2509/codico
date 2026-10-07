import * as http from 'http';
import * as https from 'https';
import type * as vscode from 'vscode';

export interface ProviderRequestOptimizer {
    optimize(provider: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface AccoProviderOptimizerOptions {
    baseUrl?: string;
    timeoutMs?: number;
}

/**
 * Minimal client for ACCO's /v1/provider/optimize boundary.
 *
 * Codico keeps canonical history, agent control, mutation and verification.
 * ACCO receives only the provider-facing request copy and may return an
 * optimized copy. Any bridge error fails open to the original request.
 */
export class AccoProviderOptimizer implements ProviderRequestOptimizer {
    private readonly endpoint: URL;
    private readonly timeoutMs: number;

    constructor(options: AccoProviderOptimizerOptions = {}) {
        this.endpoint = new URL('/v1/provider/optimize', options.baseUrl ?? 'http://127.0.0.1:8770');
        if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(this.endpoint.hostname)) {
            throw new Error('Codico ACCO integration only accepts a loopback base URL');
        }
        if (this.endpoint.protocol !== 'http:' && this.endpoint.protocol !== 'https:') {
            throw new Error('Codico ACCO integration requires http or https');
        }
        this.timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? 3000));
    }

    async optimize(provider: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
        try {
            const payload = JSON.stringify({ provider, body, options: {} });
            const response = await this.post(payload);
            if (!response || typeof response !== 'object' || Array.isArray(response)) { return body; }
            const optimized = (response as { body?: unknown; metadata?: unknown }).body;
            const metadata = (response as { metadata?: unknown }).metadata;
            const changed = Boolean(
                metadata &&
                typeof metadata === 'object' &&
                !Array.isArray(metadata) &&
                (metadata as Record<string, unknown>).changed === true
            );
            return changed && optimized && typeof optimized === 'object' && !Array.isArray(optimized)
                ? optimized as Record<string, unknown>
                : body;
        } catch {
            return body;
        }
    }

    private post(payload: string): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const transport = this.endpoint.protocol === 'https:' ? https : http;
            const req = transport.request({
                protocol: this.endpoint.protocol,
                hostname: this.endpoint.hostname,
                port: this.endpoint.port || undefined,
                path: this.endpoint.pathname + this.endpoint.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                },
            }, res => {
                let raw = '';
                let bytes = 0;
                res.on('data', (chunk: Buffer) => {
                    bytes += chunk.length;
                    if (bytes > 16 * 1024 * 1024) {
                        req.destroy(new Error('ACCO response exceeded safety limit'));
                        return;
                    }
                    raw += chunk.toString();
                });
                res.on('end', () => {
                    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                        reject(new Error(`ACCO bridge HTTP ${res.statusCode ?? 0}`));
                        return;
                    }
                    try {
                        resolve(raw ? JSON.parse(raw) : {});
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            req.setTimeout(this.timeoutMs, () => req.destroy(new Error('ACCO bridge timeout')));
            req.on('error', reject);
            req.write(payload);
            req.end();
        });
    }
}


export function accoOptimizerFromConfiguration(
    config: vscode.WorkspaceConfiguration,
    openRouterPath: boolean,
): ProviderRequestOptimizer | undefined {
    if (!openRouterPath || !config.get<boolean>('accoEnabled', false)) { return undefined; }
    try {
        return new AccoProviderOptimizer({
            baseUrl: config.get<string>('accoBaseUrl', 'http://127.0.0.1:8770'),
            timeoutMs: config.get<number>('accoTimeoutMs', 3000),
        });
    } catch {
        return undefined;
    }
}
