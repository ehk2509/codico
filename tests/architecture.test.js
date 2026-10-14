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

  // A budget per responsibility: a file that outgrows its own is doing something that belongs elsewhere
  for (const [file, budget] of [
    ['src/agentProvider.ts', 1500],    // the panel's view provider: messages in and out, the turn's setup and its end
    ['src/agentTurn.ts', 700],         // the agent loop
    ['src/workspaceTools.ts', 450],    // writing, editing, searching, commands
    ['src/threads.ts', 260],           // the thread list
    ['src/compaction.ts', 180],        // summarising a long conversation
    ['src/panelCommands.ts', 260],     // context, review, tests, commit
    ['src/turnSetup.ts', 120],         // the model, its key, the system prompt
  ]) {
    assert.ok(lines(file) < budget, `${file} has ${lines(file)} lines, over its budget of ${budget}; extract a cohesive responsibility`);
  }
  assert.ok(lines('media/chat.html') < 400,
    'chat.html should remain a small structural shell; keep style/behavior in packaged assets');

  for (const modulePath of [
    'src/externalToolRuntime.ts',
    'src/chatProtocol.ts',
    'src/webviewAssets.ts',
    'src/explorationController.ts',
    'src/agentPhasePrompt.ts',
    'src/taskAcceptance.ts',
    'src/localInvariantAudit.ts',
    'src/iterationBudget.ts',
    'src/editMatcher.ts',
    'src/approvals.ts',
    'src/agentTurn.ts',
    'src/workspaceTools.ts',
    'src/threads.ts',
    'src/compaction.ts',
    'src/panelCommands.ts',
    'src/turnSetup.ts',
    'media/chat.css',
    'media/chat.js',
  ]) {
    assert.equal(fs.existsSync(path.join(root, modulePath)), true, `missing extracted module: ${modulePath}`);
  }

  // The loop does not reach into the panel: what it shows goes through its host
  const loop = read('src/agentTurn.ts');
  assert.doesNotMatch(loop.replace(/\/\/.*$/gm, ''), /\.webview\b|\b_view\b|vscode\.window\b/, 'the agent loop must not use the panel or editor windows directly');
  for (const name of ['AgentTurn', 'WorkspaceTools', 'ThreadManager', 'Compaction', 'Approvals']) { assert.match(provider, new RegExp(`\\b${name}\\b`)); }
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
