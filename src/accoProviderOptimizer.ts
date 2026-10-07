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

export interface AccoProviderTelemetry {
    attempts: number;
    changed: number;
    failOpen: number;
    inputChars: number;
    outputChars: number;
    charsSaved: number;
    totalLatencyMs: number;
}

const telemetry: AccoProviderTelemetry = {
    attempts: 0,
    changed: 0,
    failOpen: 0,
    inputChars: 0,
    outputChars: 0,
    charsSaved: 0,
    totalLatencyMs: 0,
};

export function getAccoProviderTelemetry(): AccoProviderTelemetry {
    return { ...telemetry };
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
        const startedAt = Date.now();
        const originalJson = JSON.stringify(body);
        telemetry.attempts++;
        telemetry.inputChars += originalJson.length;
        try {
            const payload = JSON.stringify({ provider, body, options: {} });
            const response = await this.post(payload);
            if (!response || typeof response !== 'object' || Array.isArray(response)) {
                telemetry.outputChars += originalJson.length;
                return body;
            }
            const optimized = (response as { body?: unknown; metadata?: unknown }).body;
            const metadata = (response as { metadata?: unknown }).metadata;
            const changed = Boolean(
                metadata &&
                typeof metadata === 'object' &&
                !Array.isArray(metadata) &&
                (metadata as Record<string, unknown>).changed === true
            );
            if (changed && optimized && typeof optimized === 'object' && !Array.isArray(optimized)) {
                const optimizedBody = optimized as Record<string, unknown>;
                const optimizedJson = JSON.stringify(optimizedBody);
                telemetry.changed++;
                telemetry.outputChars += optimizedJson.length;
                telemetry.charsSaved += Math.max(0, originalJson.length - optimizedJson.length);
                return optimizedBody;
            }
            telemetry.outputChars += originalJson.length;
            return body;
        } catch {
            telemetry.failOpen++;
            telemetry.outputChars += originalJson.length;
            return body;
        } finally {
            telemetry.totalLatencyMs += Math.max(0, Date.now() - startedAt);
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
