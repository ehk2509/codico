const test = require('node:test');
const assert = require('node:assert/strict');

const { assertBrowserRequestAllowed } = require('../out/browserNetworkPolicy.js');

test('browser policy validates every HTTP(S) request when private access is disabled', async () => {
  const seen = [];
  const resolver = async url => { seen.push(url); };

  await assertBrowserRequestAllowed('https://example.com/app.js', false, resolver);
  assert.deepEqual(seen, ['https://example.com/app.js']);
});

test('browser policy bypasses public-network validation only after explicit opt in', async () => {
  let called = false;
  await assertBrowserRequestAllowed('http://127.0.0.1:3000', true, async () => {
    called = true;
    throw new Error('should not run');
  });
  assert.equal(called, false);
});

test('browser policy leaves non-network schemes alone', async () => {
  let called = false;
  await assertBrowserRequestAllowed('data:text/plain,hello', false, async () => {
    called = true;
  });
  assert.equal(called, false);
});
