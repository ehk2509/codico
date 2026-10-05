const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isBlockedHostname,
  isBlockedIpAddress,
  resolvePublicHttpUrl,
} = require('../out/networkSecurity.js');

test('blocks loopback, private, link-local, metadata and reserved addresses', () => {
  for (const ip of [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1',
  ]) {
    assert.equal(isBlockedIpAddress(ip), true, ip);
  }
  assert.equal(isBlockedIpAddress('8.8.8.8'), false);
  assert.equal(isBlockedIpAddress('2606:4700:4700::1111'), false);
  assert.equal(isBlockedHostname('localhost'), true);
  assert.equal(isBlockedHostname('metadata.google.internal'), true);
});

test('rejects DNS names that resolve to private infrastructure', async () => {
  await assert.rejects(
    () => resolvePublicHttpUrl('https://example.test/path', async () => [
      { address: '127.0.0.1', family: 4 },
    ]),
    /private|loopback|reserved/i,
  );
});

test('pins requests to the validated DNS result', async () => {
  let calls = 0;
  const resolved = await resolvePublicHttpUrl('https://example.test/path', async () => {
    calls++;
    return [{ address: '93.184.216.34', family: 4 }];
  });

  const lookupResult = await new Promise((resolve, reject) => {
    resolved.lookup('example.test', { family: 4 }, (err, address, family) => {
      if (err) reject(err);
      else resolve({ address, family });
    });
  });

  assert.deepEqual(lookupResult, { address: '93.184.216.34', family: 4 });
  assert.equal(calls, 1, 'pinned lookup must not resolve DNS a second time');
});
