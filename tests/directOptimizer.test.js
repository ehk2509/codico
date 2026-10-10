const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const { streamDirect } = require('../out/directProviderClient.js');
const { AccoProviderOptimizer } = require('../out/accoProviderOptimizer.js');
const { getNativeToolDefinitions } = require('../out/nativeTools.js');

const collect = async (iterable) => { const out = []; for await (const c of iterable) { out.push(c); } return out; };
const tools = getNativeToolDefinitions(false);
const history = [{ role: 'user', content: 'hello' }];

// A local OpenAI-compatible provider that records what it was sent
async function withProvider(run, reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', d => { body += d; });
    req.on('end', () => {
      const json = JSON.parse(body); requests.push(json);
      const answer = reply ? reply(json, requests.length) : undefined;
      if (answer) { res.writeHead(answer.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: answer.message } })); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = { protocol: 'http:', hostname: '127.0.0.1', port: server.address().port, path: '/v1/chat/completions' };
  try { await run(endpoint, requests); } finally { await new Promise(resolve => server.close(resolve)); }
}

// Anthropic and Gemini requests always go to the real hosts: capture them instead of sending
async function withCapturedHttps(run) {
  const sent = [];
  const original = https.request;
  https.request = (options, onResponse) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (data) => { body += data; };
    req.setTimeout = () => req; req.destroy = () => {};
    req.end = () => {
      sent.push({ host: options.hostname, path: options.path, body: JSON.parse(body) });
      const res = new EventEmitter(); res.statusCode = 200; res.setEncoding = () => {}; res.destroy = () => {};
      setImmediate(() => { onResponse(res); res.emit('end'); });
    };
    return req;
  };
  try { await run(sent); } finally { https.request = original; }
}

const marking = (seen) => ({ optimize: async (provider, body) => { seen.push({ provider, body }); return { ...body, acco_marker: provider }; } });

test('a direct OpenAI-compatible request passes through the optimizer, named by its request shape', async () => {
  await withProvider(async (endpoint, requests) => {
    const seen = [];
    const chunks = await collect(streamDirect('key', history, 'deepseek', 'deepseek-flash', undefined, undefined, 'medium', undefined, tools, endpoint, marking(seen)));
    assert.equal(chunks.find(c => c.type === 'content').text, 'ok');
    // "openai", not the provider id: ACCO refuses names it does not know (HTTP 400 for "deepseek")
    assert.equal(seen.length, 1);
    assert.equal(seen[0].provider, 'openai');
    // The optimizer gets the whole request as it would be sent, adapter fields included
    assert.equal(seen[0].body.model, 'deepseek-flash');
    assert.deepEqual(seen[0].body.thinking, { type: 'enabled' });
    assert.equal(seen[0].body.tools.length, tools.length);
    // What it returns is what is sent
    assert.equal(requests.length, 1);
    assert.equal(requests[0].acco_marker, 'openai');
  });
});

test('no optimizer: the request is sent as built', async () => {
  await withProvider(async (endpoint, requests) => {
    await collect(streamDirect('key', history, 'deepseek', 'deepseek-flash', undefined, undefined, 'medium', undefined, tools, endpoint));
    assert.equal(requests[0].acco_marker, undefined);
    assert.equal(requests[0].model, 'deepseek-flash');
  });
});

test('fail-open: an optimizer that throws, or an ACCO service that is down or answers 400, never stops the request', async () => {
  await withProvider(async (endpoint, requests) => {
    const throwing = { optimize: async () => { throw new Error('optimizer bug'); } };
    const first = await collect(streamDirect('key', history, 'deepseek', 'deepseek-flash', undefined, undefined, 'medium', undefined, [], endpoint, throwing));
    assert.equal(first.find(c => c.type === 'content').text, 'ok');
    // The real client against nothing listening
    const down = new AccoProviderOptimizer({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 200 });
    const second = await collect(streamDirect('key', history, 'deepseek', 'deepseek-flash', undefined, undefined, 'medium', undefined, [], endpoint, down));
    assert.equal(second.find(c => c.type === 'content').text, 'ok');
    assert.equal(requests.length, 2);
    assert.ok(requests.every(r => r.model === 'deepseek-flash' && r.messages.length === 2));
  });
  // A service that rejects the request (what ACCO does for an unknown provider name)
  const rejecting = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"invalid_request"}'); }); });
  await new Promise(resolve => rejecting.listen(0, '127.0.0.1', resolve));
  try {
    await withProvider(async (endpoint, requests) => {
      const acco = new AccoProviderOptimizer({ baseUrl: `http://127.0.0.1:${rejecting.address().port}`, timeoutMs: 1000 });
      const chunks = await collect(streamDirect('key', history, 'deepseek', 'deepseek-flash', undefined, undefined, 'medium', undefined, [], endpoint, acco));
      assert.equal(chunks.find(c => c.type === 'content').text, 'ok');
      assert.equal(requests[0].model, 'deepseek-flash');
    });
  } finally { await new Promise(resolve => rejecting.close(resolve)); }
});

test('a retry after the provider refused an option is optimized again', async () => {
  await withProvider(async (endpoint, requests) => {
    const seen = [];
    const chunks = await collect(streamDirect('key', history, 'openai', 'gpt-5.4-mini', undefined, undefined, 'medium', undefined, tools, endpoint, marking(seen)));
    assert.equal(chunks.find(c => c.type === 'content').text, 'ok');
    assert.equal(requests.length, 2);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].body.reasoning_effort, 'medium');
    assert.equal(seen[1].body.reasoning_effort, undefined);
    assert.ok(requests.every(r => r.acco_marker === 'openai'));
  }, (json, n) => n === 1 ? { status: 400, message: "Unsupported parameter: 'reasoning_effort'" } : undefined);
});

test('stopping while the optimizer works sends nothing', async () => {
  await withProvider(async (endpoint, requests) => {
    const controller = new AbortController();
    const slow = { optimize: (provider, body) => new Promise(resolve => setTimeout(() => resolve(body), 150)) };
    setTimeout(() => controller.abort(), 30);
    const chunks = await collect(streamDirect('key', history, 'deepseek', 'deepseek-flash', undefined, controller.signal, 'medium', undefined, [], endpoint, slow));
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(chunks, []);
    assert.equal(requests.length, 0);
  });
});

test('Anthropic and Gemini requests are optimized under the names ACCO knows', async () => {
  await withCapturedHttps(async (sent) => {
    const seen = [];
    await collect(streamDirect('key', history, 'anthropic', 'claude-sonnet-4-5-20251001', undefined, undefined, 'medium', undefined, tools, undefined, marking(seen)));
    await collect(streamDirect('key', history, 'google', 'gemini-3.5-flash', undefined, undefined, 'medium', undefined, tools, undefined, marking(seen)));
    assert.deepEqual(seen.map(s => s.provider), ['anthropic', 'gemini']);
    assert.deepEqual(sent.map(s => [s.host, s.body.acco_marker]), [['api.anthropic.com', 'anthropic'], ['generativelanguage.googleapis.com', 'gemini']]);
    // Each got its own request shape
    assert.ok(Array.isArray(seen[0].body.messages) && seen[0].body.system !== undefined && Number.isInteger(seen[0].body.max_tokens));
    assert.ok(Array.isArray(seen[1].body.contents) && seen[1].body.generationConfig !== undefined);
  });
});
