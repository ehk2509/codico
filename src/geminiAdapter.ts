/**
 * What Codico sends to and reads from the Gemini API (generativelanguage.googleapis.com)
 * beyond plain text: thinking options per model generation, thought summaries, thought
 * signatures on tool calls, and token accounting.
 */

/** The models offered with a Google AI Studio key (any other id typed in Settings is sent as it is). */
export const GEMINI_MODELS = [
    { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash' },
    { id: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash Lite' },
    { id: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro' },
    { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
];

type Effort = 'high' | 'medium' | 'low';

/** 3.5 for "gemini-3.5-flash"; 0 for an id that does not say. */
function generation(modelId: string): number {
    return Number(/gemini-(\d+(?:\.\d+)?)/.exec(modelId)?.[1] ?? 0);
}

/** Gemini 2.5 takes a thinking budget in tokens; these fit every 2.5 model's allowed range. */
const THINKING_BUDGET: Record<Effort, number> = { low: 1024, medium: 8192, high: 24_576 };

/** Tokens a thinking model may spend before a short one-shot answer. */
const QUICK_THINKING_HEADROOM = 4096;

/**
 * `generationConfig` for an agent request. Thinking models get a far higher output limit:
 * it covers their thinking as well as the answer.
 * @param thinking false leaves the thinking options out (a retry after the API refused them)
 */
export function geminiGenerationConfig(modelId: string, effort: Effort, thinking = true): Record<string, unknown> {
    const version = generation(modelId);
    if (version < 2.5) { return { maxOutputTokens: 8192 }; }
    if (!thinking) { return { maxOutputTokens: 65_536 }; }
    return {
        maxOutputTokens: 65_536,
        thinkingConfig: version >= 3
            ? { thinkingLevel: effort, includeThoughts: true }
            : { thinkingBudget: THINKING_BUDGET[effort], includeThoughts: true },
    };
}

/** `generationConfig` for a one-shot job (summaries, commit messages): little thinking, and room for it. */
export function geminiQuickConfig(modelId: string, maxTokens: number): Record<string, unknown> {
    const version = generation(modelId);
    if (version < 2.5) { return { maxOutputTokens: maxTokens }; }
    return {
        maxOutputTokens: maxTokens + QUICK_THINKING_HEADROOM,
        thinkingConfig: version >= 3 ? { thinkingLevel: 'low' } : { thinkingBudget: 512 },
    };
}

/**
 * Gemini 3 signs each tool call (`thoughtSignature`) and refuses a later request that sends
 * the call back without its signature.
 */
export function usesThoughtSignatures(modelId: string): boolean {
    return generation(modelId) >= 3;
}

/** Google's documented placeholder for a tool call that has no signature (made by another model). */
export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

export interface GeminiUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens?: number;
}

/** `usageMetadata` → token counts. Thinking is billed as output, so it counts as completion. */
export function geminiUsage(usage: unknown): GeminiUsage | undefined {
    const u = usage as { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number; cachedContentTokenCount?: number } | null | undefined;
    if (u == null || u.totalTokenCount == null) { return undefined; }
    const cached = u.cachedContentTokenCount ?? 0;
    return {
        promptTokens: u.promptTokenCount ?? 0,
        completionTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
        totalTokens: u.totalTokenCount,
        ...(cached > 0 ? { cachedTokens: cached } : {}),
    };
}
