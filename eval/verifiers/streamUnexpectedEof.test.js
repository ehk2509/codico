const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

test('unexpected provider EOF is surfaced as a recoverable stream interruption', async () => {
  const originalRequest = https.request;
  https.request = (_options, callback) => {
    const req = new EventEmitter();
    req.write = () => true;
    req.destroy = () => {};
    req.end = () => {
      const res = new PassThrough();
      res.statusCode = 200;
      res.headers = {};
      callback(res);
      queueMicrotask(() => {
        res.write('data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n');
        // Deliberately end without finish_reason or [DONE].
        res.end();
      });
    };
    return req;
  };

  try {
    delete require.cache[require.resolve('../out/openRouterClient.js')];
    const { streamOpenRouter } = require('../out/openRouterClient.js');
    const chunks = await collect(streamOpenRouter(
      'test-key',
      [{ role: 'user', content: 'hello' }],
      'test-model',
      undefined,
      undefined,
      'low',
    ));

    assert.equal(chunks.some(c => c.type === 'content' && c.text === 'partial answer'), true);
    const error = chunks.find(c => c.type === 'stream_error');
    assert.ok(error, 'unexpected EOF must produce a stream_error chunk');
    assert.match(error.message, /stream interrupted: connection closed before/i);
  } finally {
    https.request = originalRequest;
    delete require.cache[require.resolve('../out/openRouterClient.js')];
  }
});
