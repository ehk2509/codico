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
