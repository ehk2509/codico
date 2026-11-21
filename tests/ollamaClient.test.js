const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { streamOllama } = require('../out/ollamaClient.js');

/** A fake Ollama: the OpenAI-compatible endpoint (SSE) and the native one (newline-delimited JSON). */
function fakeOllama(reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      requests.push({ url: req.url, body: JSON.parse(body) });
      reply(req.url, res);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ requests, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
const collect = async (stream) => { const chunks = []; for await (const chunk of stream) { chunks.push(chunk); } return chunks; };
const text = (chunks) => chunks.filter(c => c.type === 'content').map(c => c.text).join('');
const history = [{ role: 'user', content: 'Say hello' }];

test('without a context size the OpenAI-compatible endpoint is used, as before', async () => {
  const ollama = await fakeOllama((url, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hel' }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  try {
    for (const options of [undefined, {}, { numCtx: 0 }]) {
      const chunks = await collect(streamOllama(ollama.url, history, 'qwen3:14b', undefined, undefined, undefined, options));
      assert.equal(text(chunks), 'Hello');
    }
    assert.deepEqual([...new Set(ollama.requests.map(r => r.url))], ['/v1/chat/completions']);
    assert.equal(ollama.requests[0].body.options, undefined, 'nothing about a context size is sent');
  } finally { ollama.close(); }
});

test('with a context size, the native endpoint is used and carries num_ctx, the system prompt and the history', async () => {
  const ollama = await fakeOllama((url, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'The user wants a greeting.' }, done: false }) + '\n');
    res.write(JSON.stringify({ message: { role: 'assistant', content: 'Hel' }, done: false }) + '\n');
    // A line split across two network chunks must still be read whole
    const last = JSON.stringify({ message: { role: 'assistant', content: 'lo' }, done: true, done_reason: 'stop', prompt_eval_count: 1200, eval_count: 30 }) + '\n';
    res.write(last.slice(0, 20));
    setTimeout(() => res.end(last.slice(20)), 10);
  });
  try {
    const chunks = await collect(streamOllama(ollama.url, history, 'qwen3:14b', 'Prefix.', undefined, 'Base prompt.', { numCtx: 16384.9 }));
    assert.equal(text(chunks), 'Hello');
    assert.deepEqual(chunks.filter(c => c.type === 'thinking').map(c => c.text), ['The user wants a greeting.']);
    assert.deepEqual(chunks.find(c => c.type === 'usage'), { type: 'usage', promptTokens: 1200, completionTokens: 30, totalTokens: 1230 });
    assert.equal(chunks.some(c => c.type === 'finish'), false, 'a normal stop is not reported as a cut-off');
    const [request] = ollama.requests;
    assert.equal(request.url, '/api/chat');
    assert.equal(request.body.options.num_ctx, 16384, 'a whole number of tokens');
    assert.equal(request.body.stream, true);
    assert.equal(request.body.model, 'qwen3:14b');
    assert.deepEqual(request.body.messages, [{ role: 'system', content: 'Base prompt.\n\nPrefix.' }, { role: 'user', content: 'Say hello' }]);
  } finally { ollama.close(); }
});

test('native path: a reply cut off by the length limit says so, <think> tags in the text are split out, errors surface', async () => {
  const lines = [
    [{ message: { content: '<think>plan</think>Answer' }, done: false }, { message: { content: '' }, done: true, done_reason: 'length', prompt_eval_count: 5, eval_count: 5 }],
    [{ error: 'model requires more system memory' }],
  ];
  let call = 0;
  const ollama = await fakeOllama((url, res) => { res.writeHead(200); res.end(lines[call++].map(l => JSON.stringify(l)).join('\n') + '\n'); });
  try {
    const cut = await collect(streamOllama(ollama.url, history, 'm', undefined, undefined, undefined, { numCtx: 8192 }));
    assert.equal(text(cut), 'Answer');
    assert.deepEqual(cut.filter(c => c.type === 'thinking').map(c => c.text), ['plan']);
    assert.deepEqual(cut.find(c => c.type === 'finish'), { type: 'finish', reason: 'length' });
    const failed = await collect(streamOllama(ollama.url, history, 'm', undefined, undefined, undefined, { numCtx: 8192 }));
    assert.deepEqual(failed.filter(c => c.type === 'stream_error').map(c => c.message), ['model requires more system memory']);
  } finally { ollama.close(); }
});

test('native path: an HTTP error throws, a stream that stops early is reported, and stopping ends it quietly', async () => {
  let mode = 'http500';
  const ollama = await fakeOllama((url, res) => {
    if (mode === 'http500') { res.writeHead(500); return res.end('model not found'); }
    if (mode === 'early') { res.writeHead(200); return res.end(JSON.stringify({ message: { content: 'half an ans' }, done: false }) + '\n'); }
    res.writeHead(200); res.write(JSON.stringify({ message: { content: 'slow' }, done: false }) + '\n'); // never finishes
  });
  try {
    await assert.rejects(collect(streamOllama(ollama.url, history, 'm', undefined, undefined, undefined, { numCtx: 8192 })), /Ollama HTTP 500: model not found/);
    mode = 'early';
    const early = await collect(streamOllama(ollama.url, history, 'm', undefined, undefined, undefined, { numCtx: 8192 }));
    assert.match(early.find(c => c.type === 'stream_error').message, /interrupted/);
    mode = 'hang';
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 150);
    const stopped = await collect(streamOllama(ollama.url, history, 'm', undefined, stop.signal, undefined, { numCtx: 8192 }));
    assert.equal(text(stopped), 'slow');
    assert.equal(stopped.some(c => c.type === 'stream_error'), false, 'stopping is not an error');
  } finally { ollama.close(); }
});

test('OpenAI-compatible path: thinking sent in reasoning_content (llama.cpp) or reasoning (Ollama) is shown as thinking', async () => {
  const ollama = await fakeOllama((url, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': keep-alive\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'User says ' }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning: 'hi.' }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  try {
    const chunks = await collect(streamOllama(ollama.url, history, 'qwen3:30b-a3b'));
    assert.deepEqual(chunks.filter(c => c.type === 'thinking').map(c => c.text), ['User says ', 'hi.']);
    assert.equal(text(chunks), 'Hello', 'the thinking is not part of the reply');
  } finally { ollama.close(); }
});

test('OpenAI-compatible path: a thinking effort other than the default is sent, and dropped when the model refuses it', async () => {
  let calls = 0;
  const ollama = await fakeOllama((url, res) => {
    calls++;
    if (calls === 2) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: '"llama3.1" does not support thinking' } })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  try {
    await collect(streamOllama(ollama.url, history, 'm', undefined, undefined, undefined, { effort: 'medium' }));
    assert.equal('reasoning_effort' in ollama.requests[0].body, false, 'the default effort sends nothing');
    const chunks = await collect(streamOllama(ollama.url, history, 'm', undefined, undefined, undefined, { effort: 'low' }));
    assert.equal(ollama.requests[1].body.reasoning_effort, 'low');
    assert.equal('reasoning_effort' in ollama.requests[2].body, false, 'asked again without it');
    assert.equal(text(chunks), 'ok');
  } finally { ollama.close(); }
});

test('one-shot requests: thinking off, so a short budget still gets an answer', async () => {
  const { ollamaChatCompletion } = require('../out/ollamaClient.js');
  const ollama = await fakeOllama((url, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'fix(orbits): guard a missing satellite' }, finish_reason: 'stop' }] }));
  });
  try {
    assert.equal(await ollamaChatCompletion(ollama.url, [{ role: 'user', content: 'diff' }], 'qwen3', 100), 'fix(orbits): guard a missing satellite');
    const [request] = ollama.requests;
    assert.equal(request.body.stream, false);
    assert.equal(request.body.max_tokens, 100);
    assert.equal(request.body.reasoning_effort, 'none');
    assert.deepEqual(request.body.chat_template_kwargs, { enable_thinking: false });
  } finally { ollama.close(); }
});

test('one-shot requests: a refused thinking option is dropped, and a budget spent thinking is given more room once', async () => {
  const { ollamaChatCompletion } = require('../out/ollamaClient.js');
  const replies = [
    [400, { error: { message: "Unrecognized request argument supplied: chat_template_kwargs" } }],
    // What the real server did with 100 tokens: thought through all of them and answered nothing
    [200, { choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'We need answer user…' }, finish_reason: 'length' }] }],
    [200, { choices: [{ message: { role: 'assistant', content: 'fix(orbits): use the injected clock' }, finish_reason: 'stop' }] }],
  ];
  const ollama = await fakeOllama((url, res) => {
    const [status, body] = replies.shift();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  try {
    assert.equal(await ollamaChatCompletion(ollama.url, [{ role: 'user', content: 'diff' }], 'qwen3', 100), 'fix(orbits): use the injected clock');
    assert.equal(ollama.requests.length, 3);
    assert.equal('chat_template_kwargs' in ollama.requests[1].body, false, 'sent again without the refused option');
    assert.ok(ollama.requests[2].body.max_tokens >= 800, `more room the second time: ${ollama.requests[2].body.max_tokens}`);
  } finally { ollama.close(); }
});

test('one-shot requests: a server error or no answer in time is an error, not an empty answer; stopping is quiet', async () => {
  const { ollamaChatCompletion } = require('../out/ollamaClient.js');
  const failing = await fakeOllama((url, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'request exceeds the context window: prompt (36056 tokens) leaves no room to answer in the context (32768)' } }));
  });
  const silent = await fakeOllama(() => { /* never answers */ });
  try {
    await assert.rejects(ollamaChatCompletion(failing.url, [{ role: 'user', content: 'x' }], 'm', 100), /HTTP 400: .*exceeds the context window/);
    await assert.rejects(ollamaChatCompletion(silent.url, [{ role: 'user', content: 'x' }], 'm', 100, undefined, 300), /no answer within/);
    const stop = new AbortController();
    const pending = ollamaChatCompletion(silent.url, [{ role: 'user', content: 'x' }], 'm', 100, stop.signal);
    setTimeout(() => stop.abort(), 50);
    assert.equal(await pending, '');
  } finally { failing.close(); silent.close(); }
});
