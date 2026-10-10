/**
 * What a provider's OpenAI-compatible API does differently from the generic protocol.
 * The generic client (directProviderClient) asks the adapter; providers without one
 * behave as before.
 */
export interface OpenAICompatAdapter {
    /** The API's current id for a model id (ids saved by older versions keep working). */
    modelId(id: string): string;
    /** Extra request fields (thinking mode, effort). */
    body(modelId: string, effort: 'high' | 'medium' | 'low'): Record<string, unknown>;
    /** Extra request fields for one-shot jobs (summaries, commit messages). */
    quickBody(modelId: string): Record<string, unknown>;
    /** Output token limit for a model. */
    maxTokens(modelId: string): number;
    /** The request field the limit is sent in, when it is not max_tokens. */
    maxTokensField?: string;
    /** The limit for a one-shot job that asked for `requested` tokens, when the model needs more (room to think). */
    quickMaxTokens?(modelId: string, requested: number): number;
    /** Stream delta field that carries the reasoning text. */
    reasoningField: string;
    /** The reasoning of a reply must be sent back with every later request that offers tools. */
    replayReasoning: boolean;
    /** Prompt tokens served from the provider's cache, from the usage object. */
    cachedTokens(usage: Record<string, unknown>): number | undefined;
}

/** Model ids of DeepSeek's earlier API, and the mode they stood for. */
const LEGACY_MODELS: Record<string, { id: string; thinking: boolean }> = {
    'deepseek-chat': { id: 'deepseek-flash', thinking: false },
    'deepseek-reasoner': { id: 'deepseek-flash', thinking: true },
};

/**
 * DeepSeek (api.deepseek.com). Differences from the generic OpenAI protocol:
 * - thinking is a request option (`thinking`, `reasoning_effort`: low / high / max);
 * - reasoning streams in `reasoning_content`, and when tools are offered it must be sent
 *   back with the assistant message on every later request, or the API answers 400;
 * - cache hits are reported as `prompt_cache_hit_tokens`.
 */
export const deepseekAdapter: OpenAICompatAdapter = {
    modelId: id => LEGACY_MODELS[id]?.id ?? id,
    body(modelId, effort) {
        if (LEGACY_MODELS[modelId]?.thinking === false) { return { thinking: { type: 'disabled' } }; }
        // DeepSeek has no "medium": its default, high, is Codico's Medium; Codico's High asks for max
        const reasoningEffort = effort === 'low' ? 'low' : effort === 'high' ? 'max' : 'high';
        return { thinking: { type: 'enabled' }, reasoning_effort: reasoningEffort };
    },
    // No thinking for one-shot jobs: its tokens would come out of the answer's limit
    quickBody: () => ({ thinking: { type: 'disabled' } }),
    maxTokens: () => 32_768,
    reasoningField: 'reasoning_content',
    replayReasoning: true,
    cachedTokens(usage) {
        const hit = usage.prompt_cache_hit_tokens;
        return typeof hit === 'number' && hit > 0 ? hit : undefined;
    },
};
