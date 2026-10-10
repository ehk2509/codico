/**
 * Whether to open the Get Started guide by itself: once, and only for someone who has not
 * set Codico up — an existing user who updates has a key or has chosen a model.
 */
export function shouldOnboard(state: { onboarded: boolean; keys: Record<string, boolean>; modelChosen: boolean }): boolean {
    if (state.onboarded || state.modelChosen) { return false; }
    return !Object.entries(state.keys).some(([provider, hasKey]) => hasKey && (provider === 'openrouter' || provider.startsWith('direct:')));
}
