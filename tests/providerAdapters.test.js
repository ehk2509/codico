const test = require('node:test');
const assert = require('node:assert/strict');

const { openaiAdapter, OPENAI_MODELS } = require('../out/openaiAdapter.js');
const { geminiGenerationConfig, geminiQuickConfig, geminiUsage, usesThoughtSignatures, SKIP_THOUGHT_SIGNATURE, GEMINI_MODELS } = require('../out/geminiAdapter.js');
const { toGeminiMessages } = require('../out/providerConversation.js');
const { DIRECT_PROVIDERS } = require('../out/directProviderClient.js');
const models = require('../media/models.json');

test('OpenAI: reasoning models get an effort and a limit that leaves room to think', () => {
  assert.deepEqual(openaiAdapter.body('gpt-6-sol', 'high'), { reasoning_effort: 'high' });
  assert.deepEqual(openaiAdapter.body('o3', 'low'), { reasoning_effort: 'low' });
  assert.equal(openaiAdapter.maxTokensField, 'max_completion_tokens');
  assert.equal(openaiAdapter.maxTokens('gpt-5.5'), 64000);
  // A short one-shot answer: little reasoning, and tokens for it on top of the answer's
  assert.deepEqual(openaiAdapter.quickBody('gpt-5.5'), { reasoning_effort: 'low' });
  assert.equal(openaiAdapter.quickMaxTokens('gpt-5.5', 300), 4396);
});

test('OpenAI: GPT-4 era models take no effort and keep their smaller limits', () => {
  assert.deepEqual(openaiAdapter.body('gpt-4o', 'high'), {});
  assert.deepEqual(openaiAdapter.quickBody('gpt-4o-mini'), {});
  assert.equal(openaiAdapter.maxTokens('gpt-4o-mini'), 16384);
  assert.equal(openaiAdapter.maxTokens('gpt-4-turbo'), 4096);
  assert.equal(openaiAdapter.quickMaxTokens('gpt-4o', 300), 300);
});

test('Gemini: thinking options follow the model generation', () => {
  assert.deepEqual(geminiGenerationConfig('gemini-3.5-flash', 'medium'), { maxOutputTokens: 65536, thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true } });
  assert.deepEqual(geminiGenerationConfig('gemini-3.1-pro-preview', 'high').thinkingConfig, { thinkingLevel: 'high', includeThoughts: true });
  assert.deepEqual(geminiGenerationConfig('gemini-2.5-pro', 'low'), { maxOutputTokens: 65536, thinkingConfig: { thinkingBudget: 1024, includeThoughts: true } });
  assert.deepEqual(geminiGenerationConfig('gemini-2.5-flash', 'high').thinkingConfig.thinkingBudget, 24576);
  // Before 2.5 there is no thinking, and the output limit is small
  assert.deepEqual(geminiGenerationConfig('gemini-2.0-flash', 'high'), { maxOutputTokens: 8192 });
  assert.deepEqual(geminiGenerationConfig('gemini-1.5-flash-latest', 'high'), { maxOutputTokens: 8192 });
  // The retry after the API refused a thinking option
  assert.deepEqual(geminiGenerationConfig('gemini-3.5-flash', 'medium', false), { maxOutputTokens: 65536 });
});

test('Gemini: a one-shot answer keeps its tokens even though the model thinks first', () => {
  assert.deepEqual(geminiQuickConfig('gemini-3.5-flash', 300), { maxOutputTokens: 4396, thinkingConfig: { thinkingLevel: 'low' } });
  assert.deepEqual(geminiQuickConfig('gemini-2.5-pro', 300), { maxOutputTokens: 4396, thinkingConfig: { thinkingBudget: 512 } });
  assert.deepEqual(geminiQuickConfig('gemini-2.0-flash', 300), { maxOutputTokens: 300 });
});

test('Gemini: thinking counts as output, and cache hits are reported', () => {
  assert.deepEqual(geminiUsage({ promptTokenCount: 1000, candidatesTokenCount: 40, thoughtsTokenCount: 200, totalTokenCount: 1240, cachedContentTokenCount: 800 }),
    { promptTokens: 1000, completionTokens: 240, totalTokens: 1240, cachedTokens: 800 });
  assert.deepEqual(geminiUsage({ promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 }), { promptTokens: 10, completionTokens: 4, totalTokens: 14 });
  assert.equal(geminiUsage({ promptTokenCount: 10 }), undefined);
  assert.equal(geminiUsage(undefined), undefined);
});

test('Gemini 3: a tool call goes back with its signature, or the placeholder when it has none', () => {
  assert.equal(usesThoughtSignatures('gemini-3.5-flash'), true);
  assert.equal(usesThoughtSignatures('gemini-2.5-pro'), false);
  const history = [
    { role: 'user', content: 'read both' },
    { role: 'assistant', content: '', nativeToolCalls: [{ id: 'a', name: 'read_file', arguments: { filepath: 'a.txt' }, signature: 'SIG-A' }, { id: 'b', name: 'read_file', arguments: { filepath: 'b.txt' } }] },
    { role: 'tool', toolCallId: 'a', toolName: 'read_file', content: 'A' },
    { role: 'tool', toolCallId: 'b', toolName: 'read_file', content: 'B' },
    // A call made by another model earlier in the thread: no signature
    { role: 'assistant', content: '', nativeToolCalls: [{ id: 'c', name: 'list_dir', arguments: {} }] },
    { role: 'tool', toolCallId: 'c', toolName: 'list_dir', content: 'a.txt' },
  ];
  const calls = (messages) => messages.filter(m => m.role === 'model').map(m => m.parts.filter(p => p.functionCall).map(p => p.thoughtSignature ?? null));
  assert.deepEqual(calls(toGeminiMessages(history, true, SKIP_THOUGHT_SIGNATURE)), [['SIG-A', null], [SKIP_THOUGHT_SIGNATURE]]);
  // Models before Gemini 3 are sent no placeholder
  assert.deepEqual(calls(toGeminiMessages(history, true)), [['SIG-A', null], [null]]);
});

test('the model menu lists exactly the models each direct provider declares', () => {
  for (const [id, declared] of [['openai', OPENAI_MODELS], ['google', GEMINI_MODELS]]) {
    const provider = DIRECT_PROVIDERS.find(p => p.id === id);
    assert.deepEqual(provider.models, declared);
    const group = models.find(g => g.tier === 'direct' && g.models[0].id.startsWith(`direct:${id}/`));
    assert.deepEqual(group.models.map(m => m.id), declared.map(m => `direct:${id}/${m.id}`));
    assert.deepEqual(group.models.map(m => m.label), declared.map(m => m.displayName));
  }
  assert.equal(DIRECT_PROVIDERS.find(p => p.id === 'openai').adapter, openaiAdapter);
});
