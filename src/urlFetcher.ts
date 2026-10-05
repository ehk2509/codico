import * as http from 'http';
import * as https from 'https';
import { resolvePublicHttpUrl } from './networkSecurity';

export interface FetchPublicTextOptions {
    maxRedirects?: number;
    timeoutMs?: number;
    maxBytes?: number;
    maxChars?: number;
}

export function htmlToReadableText(rawHtml: string): string {
    return rawHtml
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function fetchRaw(
    rawUrl: string,
    redirectDepth: number,
    options: Required<FetchPublicTextOptions>
): Promise<string> {
    const resolvedUrl = await resolvePublicHttpUrl(rawUrl);
    const parsed = resolvedUrl.url;

    return new Promise<string>((resolve, reject) => {
        let settled = false;
        const done = {
            resolve: (value: string) => {
                if (!settled) { settled = true; resolve(value); }
            },
            reject: (error: unknown) => {
                if (!settled) {
                    settled = true;
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            },
        };

        const transport = parsed.protocol === 'https:' ? https : http;
        const req = transport.get(parsed, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Codico/1.0)',
                'Accept': 'text/html,application/xhtml+xml,*/*',
            },
            timeout: options.timeoutMs,
            lookup: resolvedUrl.lookup,
        }, (res) => {
            const isRedirect = res.statusCode === 301 || res.statusCode === 302 ||
                res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308;
            if (isRedirect && res.headers.location) {
                res.resume();
                if (redirectDepth >= options.maxRedirects) {
                    done.reject(new Error('Too many redirects'));
                    return;
                }
                let next: URL;
                try {
                    next = new URL(res.headers.location, parsed);
                } catch {
                    done.reject(new Error(`Invalid redirect URL: ${res.headers.location}`));
                    return;
                }
                fetchRaw(next.href, redirectDepth + 1, options).then(done.resolve, done.reject);
                return;
            }

            if (res.statusCode && res.statusCode >= 400) {
                res.resume();
                done.reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }

            const chunks: Buffer[] = [];
            let totalBytes = 0;
            res.on('data', (chunk: Buffer) => {
                if (settled) { return; }
                totalBytes += chunk.length;
                if (totalBytes > options.maxBytes) {
                    res.destroy();
                    done.reject(new Error(`Response exceeded ${options.maxBytes} bytes`));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => done.resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', done.reject);
        });

        req.on('error', done.reject);
        req.on('timeout', () => {
            req.destroy();
            done.reject(new Error('Request timed out'));
        });
    });
}

export async function fetchPublicText(
    rawUrl: string,
    options: FetchPublicTextOptions = {}
): Promise<string> {
    const resolved: Required<FetchPublicTextOptions> = {
        maxRedirects: options.maxRedirects ?? 5,
        timeoutMs: options.timeoutMs ?? 15_000,
        maxBytes: options.maxBytes ?? 5 * 1024 * 1024,
        maxChars: options.maxChars ?? 24_000,
    };

    const raw = await fetchRaw(rawUrl, 0, resolved);
    const text = htmlToReadableText(raw);
    return text.length > resolved.maxChars
        ? text.slice(0, resolved.maxChars) + `\n… (truncated at ${resolved.maxChars} chars)`
        : text;
}
