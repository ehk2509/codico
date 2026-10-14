const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const secrets = new Map();
const vscodeStub = {};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain); };
test.after(() => { Module._load = originalLoad; });
const { systemPrefix, resolveModelAccess, EDITS_MODE_NOTE, SUMMARY_NOTE } = require('../out/turnSetup.js');

test('the system prefix keeps its order, and leaves out what is empty', () => {
  assert.equal(systemPrefix({}), undefined);
  assert.equal(systemPrefix({ repoInstructions: null, customPrefix: '', summary: false }), undefined);
  assert.equal(systemPrefix({ repoInstructions: 'Use tabs.', customPrefix: 'Be brief.', mcpSection: 'MCP', skillsSection: 'SKILLS', memorySection: 'MEMORY', editsMode: true, summary: true }),
    ['[Repository Instructions]\nUse tabs.', 'Be brief.', 'MCP', 'SKILLS', 'MEMORY', EDITS_MODE_NOTE, SUMMARY_NOTE].join('\n\n'));
  assert.equal(systemPrefix({ memorySection: 'MEMORY' }), 'MEMORY');
});

test('the model and its key: what each kind of model needs, and what is missing said for the user', async () => {
  const context = { secrets: { get: async (k) => secrets.get(k) }, globalState: { get: () => undefined }, workspaceState: { get: () => undefined } };
  const config = (model) => ({ get: (key, fallback) => key === 'model' ? model : key === 'ollamaBaseUrl' ? 'http://local:1' : fallback });
  const ollama = await resolveModelAccess(context, config('ollama/qwen'));
  assert.deepEqual([ollama.isOllama, ollama.ollamaModel, ollama.ollamaBaseUrl, ollama.apiKey], [true, 'qwen', 'http://local:1', '']);
  secrets.clear();
  assert.match((await resolveModelAccess(context, config('direct:deepseek/deepseek-flash'))).error, /^No API key for DeepSeek\./);
  secrets.set('codico.direct.deepseek', 'DS');
  secrets.set('codico.directApiKey.deepseek', 'DS');
  const direct = await resolveModelAccess(context, config('direct:deepseek/deepseek-flash'));
  if (!('error' in direct)) { assert.deepEqual([direct.isDirect, direct.directApiKey, direct.directParsed.providerId], [true, 'DS', 'deepseek']); }
  assert.match((await resolveModelAccess(context, config('direct:nonsense'))).error || '', /Invalid direct model ID|No API key/);
});
