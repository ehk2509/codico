const test = require('node:test');
const assert = require('node:assert/strict');

const { htmlToReadableText } = require('../out/urlFetcher.js');

test('HTML normalization strips executable/style content and decodes common entities', () => {
  const html = '<html><style>.x{display:none}</style><script>alert(1)</script><body><h1>Hello &amp; bye</h1><p>A&nbsp;B</p></body></html>';
  const text = htmlToReadableText(html);
  assert.equal(text.includes('alert(1)'), false);
  assert.equal(text.includes('display:none'), false);
  assert.match(text, /Hello & bye/);
  assert.match(text, /A B/);
});
