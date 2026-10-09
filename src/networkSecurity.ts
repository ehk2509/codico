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
        const g = parseIpv6(raw);
        if (!g) { return true; }
        // Forms that carry an IPv4 address reach that address (URLs even rewrite
        // [::ffff:127.0.0.1] to the hex form [::ffff:7f00:1]): judge the embedded IPv4
        const embedded = (hi: number, lo: number): boolean =>
            isBlockedIpAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
        const zeros = (from: number, to: number): boolean => g.slice(from, to).every(x => x === 0);
        if (zeros(0, 5) && g[5] === 0xffff) { return embedded(g[6], g[7]); } // IPv4-mapped ::ffff:0:0/96
        if (zeros(0, 6)) { return embedded(g[6], g[7]); } // IPv4-compatible ::/96, includes :: and ::1
        if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) { return embedded(g[6], g[7]); } // NAT64 64:ff9b::/96
        if (g[0] === 0x2002) { return embedded(g[1], g[2]); } // 6to4 2002::/16
        if (g[0] === 0x2001 && g[1] === 0) { return true; } // Teredo 2001::/32 (obfuscated IPv4)
        if ((g[0] & 0xfe00) === 0xfc00) { return true; } // ULA fc00::/7
        if ((g[0] & 0xffc0) === 0xfe80) { return true; } // link-local fe80::/10
        if ((g[0] & 0xff00) === 0xff00) { return true; } // multicast ff00::/8
        if (g[0] === 0x2001 && g[1] === 0xdb8) { return true; } // documentation 2001:db8::/32
        return false;
    }

    return true;
}

/** The eight 16-bit groups of an IPv6 address (with :: expanded), or null. */
function parseIpv6(address: string): number[] | null {
    let text = address.split('%')[0]; // drop a zone id
    // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes two groups
    const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (dotted) {
        const v4 = parseIpv4(dotted[1]);
        if (!v4) { return null; }
        text = text.slice(0, -dotted[1].length) + `${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
    }
    const halves = text.split('::');
    if (halves.length > 2) { return null; }
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) { return null; }
    const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map(h => parseInt(h, 16));
    return groups.length === 8 && groups.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? groups : null;
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
