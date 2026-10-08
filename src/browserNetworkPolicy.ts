import { resolvePublicHttpUrl } from './networkSecurity';

export type PublicUrlResolver = (rawUrl: string) => Promise<unknown>;

export async function assertBrowserRequestAllowed(
    rawUrl: string,
    allowPrivateNetwork: boolean,
    resolvePublic: PublicUrlResolver = resolvePublicHttpUrl
): Promise<void> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('Browser navigation requires a valid HTTP or HTTPS URL');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Browser navigation blocked unsupported URL scheme: ${parsed.protocol}`);
    }

    if (allowPrivateNetwork) { return; }
    await resolvePublic(rawUrl);
}
