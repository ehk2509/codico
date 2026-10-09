const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { streamOpenRouter } = require('../out/openRouterClient.js');
const { getNativeToolDefinitions } = require('../out/nativeTools.js');

async function withFakeServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    return await run({
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: address.port,
      path: '/chat',
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

test('unexpected provider EOF is surfaced as a recoverable stream interruption', async () => {
  const chunks = await withFakeServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n');
    // Deliberately close without finish_reason or [DONE].
    res.end();
  }, endpoint => collect(streamOpenRouter(
    'test-key',
    [{ role: 'user', content: 'hello' }],
    'test-model',
    undefined,
    undefined,
    'low',
    undefined,
    [],
    endpoint,
  )));

  assert.equal(chunks.some(c => c.type === 'content' && c.text === 'partial answer'), true);
  const error = chunks.find(c => c.type === 'stream_error');
  assert.match(error.message, /stream interrupted: connection closed before/i);
});

test('fragmented native tool arguments become one structured tool call', async () => {
  const chunks = await withFakeServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_","arguments":"{\\\"file"}}]}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"path\\\":\\\"src/a.ts\\\"}"}}]}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
    res.end('data: [DONE]\n\n');
  }, endpoint => collect(streamOpenRouter(
    'test-key',
    [{ role: 'user', content: 'read src/a.ts' }],
    'test-model',
    undefined,
    undefined,
    'low',
    undefined,
    getNativeToolDefinitions(false),
    endpoint,
  )));

  const tool = chunks.find(c => c.type === 'native_tool');
  assert.deepEqual(tool.call, {
    id: 'call_1',
    name: 'read_file',
    arguments: { filepath: 'src/a.ts' },
  });
  assert.equal(chunks.some(c => c.type === 'stream_error'), false);
});


test('native-tool capability errors retry once with fenced compatibility mode', async () => {
  let requests = 0;
  const chunks = await withFakeServer((req, res) => {
    requests++;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      if (requests === 1) {
        assert.equal(Array.isArray(parsed.tools), true);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'tools are not supported by this model' } }));
        return;
      }

      assert.equal(parsed.tools, undefined);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"fallback worked"},"finish_reason":"stop"}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  }, endpoint => collect(streamOpenRouter(
    'test-key',
    [{ role: 'user', content: 'hello' }],
    'no-tools-model',
    undefined,
    undefined,
    'low',
    undefined,
    getNativeToolDefinitions(false),
    endpoint,
  )));

  assert.equal(requests, 2);
  assert.equal(chunks.some(c => c.type === 'content' && c.text === 'fallback worked'), true);
  assert.equal(
    chunks.some(c => c.type === 'thinking' && /compatibility tool format/.test(c.text)),
    true,
  );
});


test('OpenRouter request optimizer can transform only the provider-facing request copy', async () => {
  let optimizedCalls = 0;
  const optimizer = {
    async optimize(provider, body) {
      optimizedCalls++;
      assert.equal(provider, 'openai');
      assert.equal(body.model, 'test-model');
      assert.equal(Array.isArray(body.messages), true);
      return { ...body, acco_marker: 'optimized' };
    },
  };

  const chunks = await withFakeServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(raw);
      assert.equal(parsed.acco_marker, 'optimized');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  }, endpoint => collect(streamOpenRouter(
    'test-key',
    [{ role: 'user', content: 'hello' }],
    'test-model',
    undefined,
    undefined,
    'low',
    undefined,
    [],
    endpoint,
    optimizer,
  )));

  assert.equal(optimizedCalls, 1);
  assert.equal(chunks.some(c => c.type === 'content' && c.text === 'ok'), true);
});

test('OpenRouter request continues unchanged when optimizer fails open', async () => {
  const optimizer = {
    async optimize() {
      throw new Error('ACCO unavailable');
    },
  };

  await withFakeServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(raw);
      assert.equal(parsed.acco_marker, undefined);
      assert.equal(parsed.model, 'test-model');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  }, endpoint => collect(streamOpenRouter(
    'test-key',
    [{ role: 'user', content: 'hello' }],
    'test-model',
    undefined,
    undefined,
    'low',
    undefined,
    [],
    endpoint,
    optimizer,
  )));
});

test('OpenRouter requests usage accounting and passes the reported cost through', async () => {
  let requestBody;
  const chunks = await withFakeServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      requestBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"total_tokens":150,"cost":0.00042}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  }, endpoint => collect(streamOpenRouter('test-key', [{ role: 'user', content: 'hello' }], 'test-model', undefined, undefined, 'low', undefined, [], endpoint)));

  assert.deepEqual(requestBody.usage, { include: true });
  const usage = chunks.find(c => c.type === 'usage');
  assert.equal(usage.totalTokens, 150);
  assert.equal(usage.costUsd, 0.00042);
});

test('test endpoint override only accepts http(s) URLs', () => {
  const { testOpenRouterEndpoint } = require('../out/openRouterClient.js');
  assert.deepEqual(testOpenRouterEndpoint('http://127.0.0.1:4567/api/v1/chat/completions'),
    { protocol: 'http:', hostname: '127.0.0.1', port: 4567, path: '/api/v1/chat/completions' });
  assert.equal(testOpenRouterEndpoint(undefined), undefined);
  assert.equal(testOpenRouterEndpoint('file:///etc/passwd'), undefined);
  assert.equal(testOpenRouterEndpoint('not a url'), undefined);
});

test('a character split across network chunks is decoded intact', async () => {
  const frame = Buffer.from('data: {"choices":[{"delta":{"content":"Café 日本語 🚀"}}]}\n\n');
  const chunks = await withFakeServer(async (req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // One byte per write, flushed separately, so every multi-byte character is split
    for (const byte of frame) {
      res.write(Buffer.from([byte]));
      await new Promise(r => setImmediate(r));
    }
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  }, endpoint => collect(streamOpenRouter('test-key', [{ role: 'user', content: 'hi' }], 'test-model', undefined, undefined, 'low', undefined, [], endpoint)));
  const text = chunks.filter(c => c.type === 'content').map(c => c.text).join('');
  assert.equal(text, 'Café 日本語 🚀');
});

test('a provider that stops sending is reported as a recoverable interruption', async () => {
  const { setStreamStallTimeout, isRecoverableStreamInterruption } = require('../out/streamCompletion.js');
  setStreamStallTimeout(1);
  try {
    const started = Date.now();
    const chunks = await withFakeServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      // ...and then nothing, with the connection left open
    }, endpoint => collect(streamOpenRouter('test-key', [{ role: 'user', content: 'hi' }], 'test-model', undefined, undefined, 'low', undefined, [], endpoint)));
    const error = chunks.find(c => c.type === 'stream_error');
    assert.ok(error, 'the stall is reported');
    assert.ok(isRecoverableStreamInterruption(error.message), error.message);
    assert.ok(Date.now() - started < 5000, 'reported within seconds, not never');
  } finally {
    setStreamStallTimeout(300);
  }
});
