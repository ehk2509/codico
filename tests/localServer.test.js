const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  probeLocalServer, clearLocalServerProbes, sameLocalModel, compactThreshold, compactionBudgets,
  isContextOverflow, overflowAsChunk, localServerWarning,
} = require('../out/localServer.js');
const { streamLocalOpenAICompat } = require('../out/directProviderClient.js');

/** A server answering GETs from a table of path → JSON (anything else: 404), and recording POSTs. */
function fakeServer(routes, onPost) {
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (req.method === 'POST') { posts.push({ url: req.url, body: JSON.parse(body) }); return onPost(req, res, posts.length - 1); }
      const route = routes[req.url];
      if (route === undefined) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(route));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ posts, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

test('an Ollama server: its models, and the context window of the loaded model', async () => {
  clearLocalServerProbes();
  const server = await fakeServer({
    '/api/tags': { models: [{ name: 'qwen3:30b-a3b' }, { name: 'llama3.1:latest' }] },
    '/api/ps': { models: [{ name: 'qwen3:30b-a3b', context_length: 8192 }] },
  });
  try {
    assert.deepEqual(await probeLocalServer(server.url, 'qwen3:30b-a3b'), { kind: 'ollama', models: ['qwen3:30b-a3b', 'llama3.1:latest'], contextLength: 8192 });
    // Not loaded: its context window is not known yet
    clearLocalServerProbes();
    assert.equal((await probeLocalServer(server.url, 'llama3.1')).contextLength, undefined);
  } finally { server.close(); }
});

test('an OpenAI-compatible server (llama.cpp, vLLM): its models and context window, in whichever field it uses', async () => {
  for (const entry of [
    { id: 'qwen3.8-flash-next-iq3_s', context_length: 32768 }, // the server Codico met in the wild
    { id: 'qwen3.8-flash-next-iq3_s', max_model_len: 32768 }, // vLLM
    { id: 'qwen3.8-flash-next-iq3_s', meta: { n_ctx: 32768 } }, // llama.cpp
  ]) {
    clearLocalServerProbes();
    const server = await fakeServer({ '/v1/models': { object: 'list', data: [entry] } });
    try {
      // A server with one model answers with it whatever the request names
      assert.deepEqual(await probeLocalServer(server.url, 'qwen3:30b-a3b'), { kind: 'openai', models: ['qwen3.8-flash-next-iq3_s'], contextLength: 32768 });
    } finally { server.close(); }
  }
});

test('a server that answers neither is unreachable, quickly, and the answer is remembered', async () => {
  clearLocalServerProbes();
  const server = await fakeServer({});
  try {
    assert.deepEqual(await probeLocalServer(server.url, 'm'), { kind: 'unreachable', models: [] });
    const t0 = Date.now();
    await probeLocalServer('http://127.0.0.1:1', 'm', 500);
    assert.ok(Date.now() - t0 < 3000, 'a closed port does not hang the turn');
    // Asked again within the minute: no new request
    const first = probeLocalServer(server.url, 'm');
    assert.equal(probeLocalServer(server.url, 'm'), first);
  } finally { server.close(); }
});

test('model names compare as Ollama does: a missing tag is "latest"', () => {
  assert.equal(sameLocalModel('qwen3', 'qwen3:latest'), true);
  assert.equal(sameLocalModel('Qwen3:14B', 'qwen3:14b'), true);
  assert.equal(sameLocalModel('qwen3:14b', 'qwen3:30b'), false);
});

test('the compaction threshold never lets the prompt pass 60% of a known context window', () => {
  assert.equal(compactThreshold(60000), 60000, 'unknown window: the setting');
  assert.equal(compactThreshold(60000, 32768), 19660, 'the 32k server: well before the 26.5k-token prompt it refused at 36k');
  assert.equal(compactThreshold(15000, 32768), 15000, 'a lower setting still wins');
  assert.equal(compactThreshold(60000, 2048), 2048, 'a tiny window: a floor, not zero');
  assert.equal(compactThreshold(60000, 200000), 60000);
});

test('compaction keeps and sends less for a small context window', () => {
  assert.deepEqual(compactionBudgets(undefined), { transcriptChars: 40000, summaryTokens: 4000 });
  const small = compactionBudgets(8192);
  assert.ok(small.maxTailChars < 60000 && small.transcriptChars < 40000 && small.summaryTokens < 4000, JSON.stringify(small));
  // The summary request fits: transcript (at 3 chars a token) and the summary's room inside the window
  for (const window of [8192, 32768]) {
    const b = compactionBudgets(window);
    assert.ok(b.transcriptChars / 3 + b.summaryTokens < window * 0.6, `${window}: ${JSON.stringify(b)}`);
    assert.ok(b.maxTailChars / 3 <= window * 0.25, 'the steps kept verbatim take at most a quarter of it');
  }
  assert.deepEqual(compactionBudgets(1_000_000), { maxTailChars: 60000, transcriptChars: 40000, summaryTokens: 4000 });
});

test('context-overflow errors are recognised from the servers that send them, and other errors are not', () => {
  for (const message of [
    'Ollama HTTP 400: {"error": {"type": "invalid_request_error", "message": "request exceeds the context window: prompt (36056 tokens) leaves no room to answer in the context (32768); requests are never truncated"}}',
    'Ollama HTTP 400: {"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error"}}',
    "This model's maximum context length is 32768 tokens. However, your messages resulted in 40000 tokens.",
    'context_length_exceeded',
    'prompt is too long: 210000 tokens > 200000 maximum',
  ]) { assert.equal(isContextOverflow(message), true, message); }
  for (const message of ['Ollama HTTP 500: internal error', 'Ollama stream transport error: ECONNRESET', 'model "x" not found']) {
    assert.equal(isContextOverflow(message), false, message);
  }
});

test('a request refused for its size becomes a stream_error chunk; other errors are still thrown', async () => {
  async function* failing(message) { yield { type: 'content', text: 'a' }; throw new Error(message); }
  const chunks = [];
  for await (const chunk of overflowAsChunk(failing('request exceeds the context window: prompt (36056 tokens)'))) { chunks.push(chunk); }
  assert.deepEqual(chunks, [{ type: 'content', text: 'a' }, { type: 'stream_error', message: 'request exceeds the context window: prompt (36056 tokens)' }]);
  await assert.rejects(async () => { for await (const chunk of overflowAsChunk(failing('HTTP 500'))) { void chunk; } }, /HTTP 500/);
});

test('warnings: a model the server lacks, an Ollama-only setting on another server, a small Ollama window', () => {
  const base = 'http://127.0.0.1:8092';
  const openai = { kind: 'openai', models: ['qwen3.8-flash-next-iq3_s'], contextLength: 32768 };
  assert.match(localServerWarning(openai, base, 'qwen3:30b-a3b', 0), /is not Ollama.*serves "qwen3\.8-flash-next-iq3_s", not "qwen3:30b-a3b"/);
  assert.match(localServerWarning(openai, base, 'qwen3.8-flash-next-iq3_s', 16384), /ollamaContextLength only works with Ollama.*32,768 tokens/);
  assert.equal(localServerWarning(openai, base, 'qwen3.8-flash-next-iq3_s', 0), undefined, 'a setup that does what it says');

  const ollama = { kind: 'ollama', models: ['llama3.1:latest'], contextLength: 4096 };
  assert.match(localServerWarning(ollama, base, 'qwen3:14b', 0), /no model "qwen3:14b".*ollama pull qwen3:14b/);
  assert.match(localServerWarning(ollama, base, 'llama3.1', 0), /4,096-token context window.*codico\.ollamaContextLength/);
  assert.equal(localServerWarning(ollama, base, 'llama3.1', 32768), undefined, 'the window is set: no warning');
  assert.equal(localServerWarning({ kind: 'unreachable', models: [] }, base, 'm', 0), undefined, 'the request itself reports an unreachable server');
});

test('native tools on a local server: tools sent, no output limit, tool calls and reasoning_content read back', async () => {
  const server = await fakeServer({}, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'Read the notes.' }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"filepath":"notes.txt"}' } }] }, finish_reason: 'tool_calls' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  try {
    const tools = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'] } }];
    const chunks = [];
    for await (const chunk of streamLocalOpenAICompat(server.url, [{ role: 'user', content: 'Read notes.txt' }], 'qwen3:30b-a3b', undefined, undefined, 'low', 'System.', tools)) { chunks.push(chunk); }
    const [request] = server.posts;
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.body.model, 'qwen3:30b-a3b', 'the model name as given');
    assert.deepEqual(request.body.tools.map(t => t.function.name), ['read_file']);
    assert.equal(request.body.max_tokens, undefined, 'no output limit: the server leaves the reply what its window has room for');
    assert.equal(request.body.reasoning_effort, 'low');
    assert.deepEqual(chunks.filter(c => c.type === 'thinking').map(c => c.text), ['Read the notes.']);
    const call = chunks.find(c => c.type === 'native_tool');
    assert.equal(call.call.name, 'read_file');
    assert.deepEqual(call.call.arguments, { filepath: 'notes.txt' });
  } finally { server.close(); }
});

test('native tools on a local server: the default effort sends nothing, and a refused effort is dropped', async () => {
  const server = await fakeServer({}, (req, res, index) => {
    if (index === 1) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: '"llama3.1" does not support thinking' })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  try {
    const tools = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }];
    const run = async (effort) => { const out = []; for await (const c of streamLocalOpenAICompat(server.url, [{ role: 'user', content: 'hi' }], 'llama3.1', undefined, undefined, effort, 'System.', tools)) { out.push(c); } return out; };
    await run('medium');
    assert.equal('reasoning_effort' in server.posts[0].body, false);
    const chunks = await run('high');
    assert.equal(server.posts[1].body.reasoning_effort, 'high');
    assert.equal('reasoning_effort' in server.posts[2].body, false, 'sent again without it');
    assert.equal(chunks.filter(c => c.type === 'content').map(c => c.text).join(''), 'ok');
  } finally { server.close(); }
});
