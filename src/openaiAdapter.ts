import { OpenAICompatAdapter } from './deepseekAdapter';

/** The models offered with an OpenAI API key (any other id typed in Settings is sent as it is). */
export const OPENAI_MODELS = [
    { id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' },
    { id: 'gpt-6-sol', displayName: 'GPT-6 Sol' },
    { id: 'gpt-6-astra', displayName: 'GPT-6 Astra' },
    { id: 'gpt-6-luna', displayName: 'GPT-6 Luna' },
    { id: 'gpt-5.5', displayName: 'GPT-5.5' },
    { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini' },
];

/** GPT-4 and earlier chat models do not reason: they take no effort option and have a small output limit. */
const isLegacyChatModel = (modelId: string): boolean => /^(gpt-3|gpt-4|chatgpt-4)/.test(modelId);

/** Tokens a reasoning model may spend thinking before a short one-shot answer. */
const QUICK_REASONING_HEADROOM = 4096;

/**
 * OpenAI (api.openai.com). Differences from the generic OpenAI-compatible protocol:
 * - the output limit is `max_completion_tokens` (reasoning models refuse `max_tokens`),
 *   and it covers the reasoning as well as the answer;
 * - reasoning models take `reasoning_effort`; their reasoning text is not returned;
 * - cache hits are reported in `prompt_tokens_details.cached_tokens` (read by the generic client).
 */
export const openaiAdapter: OpenAICompatAdapter = {
    modelId: id => id,
    body: (modelId, effort) => isLegacyChatModel(modelId) ? {} : { reasoning_effort: effort },
    quickBody: modelId => isLegacyChatModel(modelId) ? {} : { reasoning_effort: 'low' },
    maxTokens: modelId => !isLegacyChatModel(modelId) ? 64_000 : /^gpt-4(o|\.1)/.test(modelId) ? 16_384 : 4096,
    quickMaxTokens: (modelId, requested) => isLegacyChatModel(modelId) ? requested : requested + QUICK_REASONING_HEADROOM,
    maxTokensField: 'max_completion_tokens',
    reasoningField: 'reasoning',
    replayReasoning: false,
    cachedTokens: () => undefined,
};
