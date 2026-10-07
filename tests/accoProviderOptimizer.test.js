const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { AccoProviderOptimizer } = require('../out/accoProviderOptimizer.js');

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('ACCO bridge returns optimized provider body when metadata marks it changed', async () => {
  const original = { model: 'test', messages: [{ role: 'user', content: 'hello' }] };
  await withServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(raw);
      assert.equal(req.url, '/v1/provider/optimize');
      assert.equal(payload.provider, 'openai');
      assert.deepEqual(payload.body, original);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        schema: 1,
        body: { ...payload.body, acco_marker: true },
        metadata: { changed: true },
      }));
    });
  }, async baseUrl => {
    const acco = new AccoProviderOptimizer({ baseUrl, timeoutMs: 1000 });
    const result = await acco.optimize('openai', original);
    assert.equal(result.acco_marker, true);
    assert.deepEqual(original, { model: 'test', messages: [{ role: 'user', content: 'hello' }] });
  });
});

test('ACCO bridge fails open when local service is unavailable', async () => {
  const original = { model: 'test', messages: [] };
  const acco = new AccoProviderOptimizer({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 100 });
  const result = await acco.optimize('openai', original);
  assert.equal(result, original);
});

test('ACCO bridge ignores unchanged or malformed optimization responses', async () => {
  const original = { model: 'test', messages: [] };
  await withServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ body: { destructive: true }, metadata: { changed: false } }));
  }, async baseUrl => {
    const acco = new AccoProviderOptimizer({ baseUrl });
    const result = await acco.optimize('openai', original);
    assert.equal(result, original);
  });
});

test('ACCO bridge refuses non-loopback endpoints', () => {
  assert.throws(
    () => new AccoProviderOptimizer({ baseUrl: 'https://example.com:8770' }),
    /loopback/i,
  );
});
