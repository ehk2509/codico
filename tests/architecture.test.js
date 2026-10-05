const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const lines = p => read(p).split(/\r?\n/).length;

test('core orchestration and webview shell stay decomposed', () => {
  const provider = read('src/agentProvider.ts');
  const html = read('media/chat.html');

  assert.ok(lines('src/agentProvider.ts') < 2900,
    'AgentProvider exceeded the architecture budget; extract a cohesive responsibility');
  assert.ok(lines('media/chat.html') < 400,
    'chat.html should remain a small structural shell; keep style/behavior in packaged assets');

  for (const modulePath of [
    'src/externalToolRuntime.ts',
    'src/chatProtocol.ts',
    'src/webviewAssets.ts',
    'src/explorationController.ts',
    'src/agentPhasePrompt.ts',
    'src/localInvariantAudit.ts',
    'media/chat.css',
    'media/chat.js',
  ]) {
    assert.equal(fs.existsSync(path.join(root, modulePath)), true, `missing extracted module: ${modulePath}`);
  }

  assert.match(provider, /ExternalToolRuntime/);
  assert.match(provider, /WebviewAssets/);
  assert.match(html, /\{\{CHAT_CSS_URI\}\}/);
  assert.match(html, /\{\{CHAT_JS_URI\}\}/);
});

test('webview CSP keeps packaged assets explicit and nonce-bound', () => {
  const html = read('media/chat.html');
  assert.match(html, /style-src \{\{CSP_SOURCE\}\} 'unsafe-inline'/);
  assert.match(html, /<script nonce="\{\{NONCE\}\}" src="\{\{CHAT_JS_URI\}\}"><\/script>/);
  assert.ok(lines('media/chat.css') > 1000, 'expected extracted stylesheet');
  assert.ok(lines('media/chat.js') > 2000, 'expected extracted chat behavior');
});
