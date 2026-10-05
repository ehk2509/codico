const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MEDIA = path.join(__dirname, '..', 'media');

// A syntax error in any webview script silently disables the whole chat panel
// (no button or input gets wired up), so every script must at least parse.
test('chat.html inline scripts parse', () => {
  const html = fs.readFileSync(path.join(MEDIA, 'chat.html'), 'utf8');
  const blocks = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attrs]) => !/type="application\/json"/.test(attrs) && !/\bsrc=/.test(attrs));
  assert.ok(blocks.length > 0, 'expected inline scripts in chat.html');
  for (const [, , body] of blocks) {
    const line = html.slice(0, html.indexOf(body)).split('\n').length;
    assert.doesNotThrow(() => new vm.Script(body), `script starting at chat.html line ${line} does not parse`);
  }
});

test('standalone webview scripts parse', () => {
  const files = fs.readdirSync(MEDIA).filter(f => f.endsWith('.js'));
  assert.ok(files.length > 0, 'expected .js files in media/');
  for (const f of files) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(MEDIA, f), 'utf8')), `media/${f} does not parse`);
  }
});
