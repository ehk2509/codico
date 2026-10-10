const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { deepseekAdapter } = require('../out/deepseekAdapter.js');
const { streamDirect, getDirectProvider } = require('../out/directProviderClient.js');
const { toOpenAIMessages } = require('../out/providerConversation.js');
const { appendAssistantIteration } = require('../out/agentHistory.js');
const { getNativeToolDefinitions } = require('../out/nativeTools.js');

// A server that follows DeepSeek's documented rules
async function withDeepSeek(run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      // With tools, every earlier assistant message must carry its reasoning_content
      if (body.tools && body.messages.some(m => m.role === 'assistant' && m.reasoning_content === undefined)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Missing reasoning_content in an assistant message.' } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta, extra = {}) => res.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }], ...extra }) + '\n\n');
      send({ reasoning_content: 'The user wants the notes. ' });
      send({ reasoning_content: 'I should read the file.' });
      send({ content: 'Reading it.' });
      send({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"filepath":"notes.txt"}' } }] });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run({ protocol: 'http:', hostname: '127.0.0.1', port: server.address().port, path: '/v1/chat/completions' }, requests);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
const collect = async (iterable) => { const out = []; for await (const c of iterable) { out.push(c); } return out; };
const tools = getNativeToolDefinitions(false);

test('DeepSeek is registered with its current models and its adapter', () => {
  const provider = getDirectProvider('deepseek');
  assert.deepEqual(provider.models.map(m => m.id), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(provider.adapter, deepseekAdapter);
  assert.equal(getDirectProvider('groq').adapter, undefined, 'other providers keep the generic protocol');
});

test('model ids saved by older versions keep working, in the mode they stood for', () => {
  assert.equal(deepseekAdapter.modelId('deepseek-chat'), 'deepseek-flash');
  assert.deepEqual(deepseekAdapter.body('deepseek-chat', 'high'), { thinking: { type: 'disabled' } });
  assert.equal(deepseekAdapter.modelId('deepseek-reasoner'), 'deepseek-flash');
  assert.deepEqual(deepseekAdapter.body('deepseek-reasoner', 'medium'), { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  assert.equal(deepseekAdapter.modelId('deepseek-v4-pro'), 'deepseek-v4-pro');
});

test("Codico's effort maps to DeepSeek's low / high / max", () => {
  const effort = e => deepseekAdapter.body('deepseek-flash', e).reasoning_effort;
  assert.deepEqual(['low', 'medium', 'high'].map(effort), ['low', 'high', 'max']);
});

test('a DeepSeek reply: reasoning is shown, kept for replay, and cache hits are reported', async () => {
  await withDeepSeek(async (endpoint, requests) => {
    const chunks = await collect(streamDirect('key', [{ role: 'user', content: 'read the notes' }], 'deepseek', 'deepseek-flash', undefined, undefined, 'medium', undefined, tools, endpoint));
    assert.equal(requests[0].model, 'deepseek-flash');
    assert.deepEqual(requests[0].thinking, { type: 'enabled' });
    assert.equal(requests[0].reasoning_effort, 'high');
    assert.equal(requests[0].max_tokens, 32768);
    assert.equal(chunks.filter(c => c.type === 'thinking').map(c => c.text).join(''), 'The user wants the notes. I should read the file.');
    assert.deepEqual(chunks.find(c => c.type === 'reasoning'), { type: 'reasoning', text: 'The user wants the notes. I should read the file.' });
    assert.equal(chunks.find(c => c.type === 'native_tool').call.name, 'read_file');
    assert.equal(chunks.find(c => c.type === 'usage').cachedTokens, 900);
  });
});

test('the reasoning is sent back with the next request, which DeepSeek requires when tools are offered', async () => {
  await withDeepSeek(async (endpoint, requests) => {
    const history = [{ role: 'user', content: 'read the notes' }];
    // What the agent stores after the first reply
    appendAssistantIteration(history, 'Reading it.', [{ call: { id: 'call_1', name: 'read_file', arguments: { filepath: 'notes.txt' } }, result: 'NOTES' }], '', 'I should read the file.');
    const chunks = await collect(streamDirect('key', history, 'deepseek', 'deepseek-flash', undefined, undefined, 'medium', undefined, tools, endpoint));
    assert.equal(requests.length, 1, 'accepted first time (no 400, no fallback retry)');
    assert.equal(requests[0].messages.find(m => m.role === 'assistant').reasoning_content, 'I should read the file.');
    assert.ok(chunks.some(c => c.type === 'content'));

    // Without the adapter's replay the same history is rejected: this is what the generic protocol sent
    const generic = toOpenAIMessages(history, true);
    assert.equal(generic.find(m => m.role === 'assistant').reasoning_content, undefined);
  });
});

test('replies from another provider earlier in the thread still get the field', () => {
  const history = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'From another model.' },
    { role: 'assistant', content: '', nativeToolCalls: [{ id: 'c', name: 'read_file', arguments: {} }] }];
  const sent = toOpenAIMessages(history, true, 'reasoning_content');
  assert.deepEqual(sent.filter(m => m.role === 'assistant').map(m => m.reasoning_content), ['', '']);
});
