import { resolvePublicHttpUrl } from './networkSecurity';

export type PublicUrlResolver = (rawUrl: string) => Promise<unknown>;

export async function assertBrowserRequestAllowed(
    rawUrl: string,
    allowPrivateNetwork: boolean,
    resolvePublic: PublicUrlResolver = resolvePublicHttpUrl
): Promise<void> {
    if (allowPrivateNetwork) { return; }

    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { return; }
    await resolvePublic(rawUrl);
}
