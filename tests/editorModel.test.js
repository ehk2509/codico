const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const shown = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') { return { window: { showInformationMessage: (m) => { shown.push(m); return Promise.resolve(); } } }; }
  return originalLoad.call(this, request, parent, isMain);
};
const { unsupportedEditorModel, notifyUnsupportedModelOnce } = require('../out/editorModel.js');
test.after(() => { Module._load = originalLoad; });

test('editor features skip models their endpoint would reject', () => {
  assert.equal(unsupportedEditorModel('deepseek/deepseek-v4-flash'), false);
  assert.equal(unsupportedEditorModel('anthropic/claude-sonnet-5.5'), false);
  assert.equal(unsupportedEditorModel('direct:anthropic/claude-sonnet-5-5'), true, 'OpenRouter rejects direct-provider ids');
  assert.equal(unsupportedEditorModel('ollama/qwen3'), true, 'not sent to OpenRouter');
  assert.equal(unsupportedEditorModel('ollama/qwen3', true), false, 'inline completions support Ollama');
});

test('the notice for features that run while typing is shown once', () => {
  notifyUnsupportedModelOnce('Inline completions', 'direct:openai/gpt-5', true);
  notifyUnsupportedModelOnce('Inline completions', 'direct:openai/gpt-5', true);
  assert.equal(shown.length, 1);
  assert.match(shown[0], /need an OpenRouter or Ollama model; the selected model \(direct:openai\/gpt-5\)/);
});
