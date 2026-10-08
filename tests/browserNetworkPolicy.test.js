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

test('browser policy rejects non-HTTP schemes even when private access is enabled', async () => {
  for (const url of [
    'file:///etc/passwd',
    'data:text/plain,hello',
    'javascript:alert(1)',
    'chrome://settings/',
  ]) {
    await assert.rejects(
      assertBrowserRequestAllowed(url, true, async () => {}),
      /unsupported URL scheme/,
    );
  }
});

test('browser policy rejects malformed URLs instead of failing open', async () => {
  await assert.rejects(
    assertBrowserRequestAllowed('not a url', false, async () => {}),
    /valid HTTP or HTTPS URL/,
  );
});
