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

function installSseResponse(frames) {
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
        for (const frame of frames) res.write(frame);
        res.end();
      });
    };
    return req;
  };
  return () => { https.request = originalRequest; };
}

async function runScenario(frames) {
  const restore = installSseResponse(frames);
  try {
    delete require.cache[require.resolve('../out/openRouterClient.js')];
    const { streamOpenRouter } = require('../out/openRouterClient.js');
    return await collect(streamOpenRouter(
      'test-key',
      [{ role: 'user', content: 'hello' }],
      'test-model',
      undefined,
      undefined,
      'low',
    ));
  } finally {
    restore();
    delete require.cache[require.resolve('../out/openRouterClient.js')];
  }
}

test('unexpected provider EOF is reported without flagging normal completion', async () => {
  const premature = await runScenario([
    'data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n',
  ]);
  assert.equal(
    premature.some(c => c.type === 'content' && c.text === 'partial answer'),
    true,
    'partial content should still be delivered before the interruption',
  );
  const interruption = premature.find(c => c.type === 'stream_error');
  assert.ok(interruption, 'unexpected EOF must produce a stream_error chunk');
  assert.match(
    interruption.message,
    /(stream|connection|completion|eof|interrupt|unexpected|closed|ended)/i,
    'stream_error should describe the premature interruption',
  );

  const done = await runScenario([
    'data: {"choices":[{"delta":{"content":"done answer"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  assert.equal(
    done.some(c => c.type === 'stream_error'),
    false,
    '[DONE] is a terminal completion marker and must not be reported as interrupted',
  );

  const finishReason = await runScenario([
    'data: {"choices":[{"delta":{"content":"finished answer"},"finish_reason":"stop"}]}\n\n',
  ]);
  assert.equal(
    finishReason.some(c => c.type === 'stream_error'),
    false,
    'a normal provider finish_reason is terminal and must not be reported as interrupted',
  );
});
