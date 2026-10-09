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

test('IPv6 forms that carry a private IPv4 address are blocked; public IPv6 is not', () => {
  const { isBlockedIpAddress } = require('../out/networkSecurity.js');
  // URLs rewrite [::ffff:127.0.0.1] to [::ffff:7f00:1]: both forms must be caught
  for (const ip of ['::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '::7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', '2002:a9fe:a9fe::1',
    '2001:0:1::1', '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '2001:db8::1']) {
    assert.equal(isBlockedIpAddress(ip), true, ip);
  }
  for (const ip of ['::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isBlockedIpAddress(ip), false, ip);
  }
});

test('fetch_url cannot reach a local server through an IPv4-mapped IPv6 address', async () => {
  const http = require('node:http');
  const { fetchPublicText } = require('../out/urlFetcher.js');
  const server = http.createServer((req, res) => res.end('LOCAL-SECRET'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    for (const host of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::127.0.0.1]']) {
      await assert.rejects(fetchPublicText(`http://${host}:${port}/`), /private|loopback|reserved/, host);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
