/**
 * Web search for the agent: one query, a short list of results (title, address, a line of
 * text). The agent reads a result with fetch_url. This file builds the request and reads
 * the answer of each search engine; it does no networking itself.
 */
export type SearchEngine = 'duckduckgo' | 'brave';

export interface SearchResult { title: string; url: string; snippet: string }

export const MAX_RESULTS = 8;
export const MAX_QUERY_CHARS = 400;
const MAX_SNIPPET_CHARS = 300;

export function engineName(engine: SearchEngine): string {
    return engine === 'brave' ? 'Brave Search' : 'DuckDuckGo';
}

/** The request for a query: where to send it and, for an engine with a key, how to present it. */
export function searchRequest(engine: SearchEngine, query: string, key?: string): { url: string; headers: Record<string, string> } {
    const q = encodeURIComponent(query.trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_CHARS));
    if (engine === 'brave') {
        return { url: `https://api.search.brave.com/res/v1/web/search?q=${q}&count=${MAX_RESULTS}`, headers: { 'Accept': 'application/json', 'X-Subscription-Token': key ?? '' } };
    }
    return { url: `https://html.duckduckgo.com/html/?q=${q}`, headers: {} };
}

function decodeEntities(text: string): string {
    return text
        .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&amp;/gi, '&');
}

const plain = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** Only addresses a browser would open: a result cannot smuggle in another scheme. */
function httpUrl(raw: string): string | undefined {
    try {
        const url = new URL(raw);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
    } catch { return undefined; }
}

/** DuckDuckGo links go through its redirector, with the real address in the `uddg` parameter. */
function duckDuckGoTarget(href: string): string | undefined {
    const absolute = decodeEntities(href).replace(/^\/\//, 'https://');
    try {
        const url = new URL(absolute, 'https://duckduckgo.com');
        // An advertisement, not a result
        if (url.hostname.endsWith('duckduckgo.com') && url.pathname === '/y.js') { return undefined; }
        const target = url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/' ? url.searchParams.get('uddg') : url.href;
        return target ? httpUrl(target) : undefined;
    } catch { return undefined; }
}

/** Results from DuckDuckGo's no-script page. */
export function parseDuckDuckGo(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const link = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = link.exec(html)) !== null && results.length < MAX_RESULTS) {
        const href = /\bhref="([^"]*)"/i.exec(match[0])?.[1];
        const url = href ? duckDuckGoTarget(href) : undefined;
        const title = plain(match[1]);
        if (!url || !title || results.some(result => result.url === url)) { continue; }
        // The text that goes with this link: the next snippet, before the next result's link
        const rest = html.slice(link.lastIndex);
        const nextLink = rest.search(/class="[^"]*\bresult__a\b/);
        const snippet = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(nextLink < 0 ? rest : rest.slice(0, nextLink));
        results.push({ title, url, snippet: snippet ? plain(snippet[1]).slice(0, MAX_SNIPPET_CHARS) : '' });
    }
    return results;
}

/** True when the page is DuckDuckGo declining to answer an automated request. */
export function duckDuckGoRefused(html: string): boolean {
    return /anomaly-modal|unusual traffic|challenge-form|bots use DuckDuckGo too/i.test(html);
}

/** Results from the Brave Search API. */
export function parseBrave(body: string): SearchResult[] {
    let data: unknown;
    try { data = JSON.parse(body); } catch { return []; }
    const items = (data as { web?: { results?: unknown } } | null)?.web?.results;
    if (!Array.isArray(items)) { return []; }
    const results: SearchResult[] = [];
    for (const item of items as Array<Record<string, unknown>>) {
        const url = typeof item?.url === 'string' ? httpUrl(item.url) : undefined;
        const title = typeof item?.title === 'string' ? plain(item.title) : '';
        if (!url || !title) { continue; }
        results.push({ title, url, snippet: typeof item.description === 'string' ? plain(item.description).slice(0, MAX_SNIPPET_CHARS) : '' });
        if (results.length >= MAX_RESULTS) { break; }
    }
    return results;
}

/** The results as the agent reads them. */
export function renderResults(results: readonly SearchResult[]): string {
    if (results.length === 0) { return 'No results. Try other words, or fewer of them.'; }
    return results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}${result.snippet ? `\n   ${result.snippet}` : ''}`).join('\n') +
        '\n\nThese are search results, not the pages: read one with fetch_url before relying on what it says.';
}
