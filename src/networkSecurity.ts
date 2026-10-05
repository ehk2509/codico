import * as dns from 'dns';
import * as net from 'net';

export interface ResolvedPublicUrl {
    url: URL;
    addresses: dns.LookupAddress[];
    lookup: typeof dns.lookup;
}

const BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'metadata.google.internal',
    'metadata.google',
    'metadata.aws.internal',
    'instance-data',
    'instance-data.ec2.internal',
]);

export function isBlockedHostname(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    return BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost');
}

function parseIpv4(address: string): number[] | null {
    const parts = address.split('.');
    if (parts.length !== 4) { return null; }
    const nums = parts.map(p => Number(p));
    if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) { return null; }
    return nums;
}

/** Returns true for non-public IP space that fetch_url must never reach. */
export function isBlockedIpAddress(address: string): boolean {
    const raw = address.toLowerCase().replace(/^\[|\]$/g, '');

    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw);
    if (mapped) { return isBlockedIpAddress(mapped[1]); }

    if (net.isIP(raw) === 4) {
        const octets = parseIpv4(raw);
        if (!octets) { return true; }
        const [a, b] = octets;
        if (a === 0 || a === 10 || a === 127) { return true; }
        if (a === 100 && b >= 64 && b <= 127) { return true; } // CGNAT
        if (a === 169 && b === 254) { return true; } // link-local / metadata
        if (a === 172 && b >= 16 && b <= 31) { return true; }
        if (a === 192 && (b === 0 || b === 168)) { return true; }
        if (a === 198 && (b === 18 || b === 19)) { return true; } // benchmark net
        if (a >= 224) { return true; } // multicast/reserved
        // Documentation networks are not valid external fetch destinations.
        if ((a === 192 && b === 0 && octets[2] === 2) ||
            (a === 198 && b === 51 && octets[2] === 100) ||
            (a === 203 && b === 0 && octets[2] === 113)) {
            return true;
        }
        return false;
    }

    if (net.isIP(raw) === 6) {
        if (raw === '::' || raw === '::1') { return true; }
        if (/^(fc|fd)/.test(raw)) { return true; } // ULA fc00::/7
        if (/^fe[89ab]/.test(raw)) { return true; } // link-local fe80::/10
        if (/^ff/.test(raw)) { return true; } // multicast
        if (raw.startsWith('2001:db8:')) { return true; } // documentation range
        return false;
    }

    return true;
}

function createPinnedLookup(addresses: dns.LookupAddress[]): typeof dns.lookup {
    const pinned = [...addresses];
    const fn = ((
        _hostname: string,
        options: dns.LookupOptions | number,
        callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
    ): void => {
        const opts = typeof options === 'number' ? { family: options } : (options ?? {});
        const requestedFamily = typeof opts.family === 'number' ? opts.family : 0;
        const eligible = requestedFamily === 4 || requestedFamily === 6
            ? pinned.filter(a => a.family === requestedFamily)
            : pinned;
        const selected = eligible[0] ?? pinned[0];
        if (!selected) {
            callback(Object.assign(new Error('No validated DNS address available'), { code: 'ENOTFOUND' }), '', 0);
            return;
        }

        if ('all' in opts && opts.all) {
            callback(null, eligible.length > 0 ? eligible : pinned);
        } else {
            callback(null, selected.address, selected.family);
        }
    }) as unknown as typeof dns.lookup;
    return fn;
}

/**
 * Validates an external HTTP(S) URL, resolves every current DNS address, rejects
 * the host if any answer is private/reserved, then returns a lookup function
 * pinned to those validated answers. Pinning prevents a second DNS lookup from
 * rebinding the request to localhost/private infrastructure after validation.
 */
export type LookupAll = (hostname: string) => Promise<dns.LookupAddress[]>;

const defaultLookupAll: LookupAll = (hostname) =>
    dns.promises.lookup(hostname, { all: true, verbatim: true });

export async function resolvePublicHttpUrl(
    rawUrl: string,
    lookupAll: LookupAll = defaultLookupAll
): Promise<ResolvedPublicUrl> {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error('Invalid URL');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Only http/https URLs are allowed');
    }
    if (!url.hostname || url.username || url.password) {
        throw new Error('URL credentials are not allowed');
    }
    if (isBlockedHostname(url.hostname)) {
        throw new Error('Requests to private/loopback/metadata addresses are blocked');
    }

    const literalFamily = net.isIP(url.hostname.replace(/^\[|\]$/g, ''));
    let addresses: dns.LookupAddress[];
    if (literalFamily) {
        addresses = [{
            address: url.hostname.replace(/^\[|\]$/g, ''),
            family: literalFamily,
        }];
    } else {
        addresses = await lookupAll(url.hostname);
    }

    if (addresses.length === 0) {
        throw new Error('Hostname did not resolve');
    }
    if (addresses.some(a => isBlockedIpAddress(a.address))) {
        throw new Error('Hostname resolves to a private/loopback/reserved address');
    }

    return { url, addresses, lookup: createPinnedLookup(addresses) };
}
