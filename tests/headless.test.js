const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? { ExtensionMode: { Test: 3, Production: 1 } } : originalLoad.call(this, request, parent, isMain); };
test.after(() => { Module._load = originalLoad; });

const { parseArgs, resolveVscode, render, EXIT, HELP } = require('../bin/codico.js');
const { parseHeadlessTask, dialogAnswer, headlessEvent, isHeadless, KEY_VARIABLES, EXIT: EXTENSION_EXIT } = require('../out/headless.js');

test('the command line: nothing is allowed unless asked for, and mistakes are named', () => {
  const plain = parseArgs(['run', 'fix', 'the', 'bug']);
  assert.deepEqual([plain.prompt, plain.permissions, plain.allowWeb, plain.allowHooks, plain.json, plain.timeout], ['fix the bug', 'read', undefined, undefined, false, 1800]);
  assert.equal(parseArgs(['run', 'x', '--allow-edits']).permissions, 'edits');
  assert.equal(parseArgs(['run', 'x', '--allow-commands']).permissions, 'all');
  assert.equal(parseArgs(['run', 'x', '--allow-commands', '--allow-edits']).permissions, 'all', 'the order does not weaken it');
  const full = parseArgs(['run', 'do it', '--cwd', '.', '--model', 'direct:deepseek/deepseek-flash', '--allow-web', '--allow-hooks', '--json', '--max-steps', '12', '--timeout', '60', '--ollama-url', 'http://127.0.0.1:1']);
  assert.deepEqual([full.model, full.allowWeb, full.allowHooks, full.json, full.maxSteps, full.timeout, full.cwd], ['direct:deepseek/deepseek-flash', true, true, true, 12, 60, process.cwd()]);
  assert.deepEqual(parseArgs(['--help']), { help: true });
  for (const [args, message] of [[[], /give a command, "run"/], [['run'], /Give the task after "run"/], [['deploy', 'x'], /Unknown command "deploy"/], [['run', 'x', '--yolo'], /Unknown option --yolo/],
    [['run', 'x', '--model'], /--model needs a value/], [['run', 'x', '--model', '--json'], /--model needs a value/], [['run', 'x', '--timeout', 'soon'], /--timeout needs a positive number/], [['run', 'x', '--max-steps', '0'], /needs a positive number/]]) {
    assert.throws(() => parseArgs(args), message, args.join(' '));
  }
  assert.match(HELP, /--allow-commands[\s\S]*Exit codes[\s\S]*xvfb-run/);
  assert.deepEqual(EXIT, { done: 0, failed: 1, needsInput: 2, denied: 3, usage: 64 });
  assert.deepEqual(EXTENSION_EXIT, { done: 0, failed: 1, needsInput: 2, denied: 3 }, 'the extension and the command agree on what the codes mean');
});

test('the editor program is found behind its launcher script', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-cli-'));
  fs.mkdirSync(path.join(root, 'bin')); fs.writeFileSync(path.join(root, 'bin', 'code'), '#!/bin/sh\n'); fs.writeFileSync(path.join(root, 'code'), 'program');
  fs.symlinkSync(path.join(root, 'bin', 'code'), path.join(root, 'link'));
  if (process.platform === 'linux') {
    assert.equal(resolveVscode(path.join(root, 'bin', 'code')), fs.realpathSync(path.join(root, 'code')));
    assert.equal(resolveVscode(path.join(root, 'link')), fs.realpathSync(path.join(root, 'code')), 'a link on the PATH is followed first');
  }
  assert.equal(resolveVscode(path.join(root, 'code')), fs.realpathSync(path.join(root, 'code')), 'the program itself is used as it is');
  assert.equal(resolveVscode(path.join(root, 'missing')), undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('what a person sees: the reply on standard output, the steps and what was declined beside it', () => {
  assert.deepEqual(render({ type: 'text', text: 'Done.' }), { stream: 'out', text: 'Done.' });
  assert.deepEqual(render({ type: 'step', tool: 'read_file', label: 'src/a.ts' }), { stream: 'err', text: '\n  ▸ read_file src/a.ts\n' });
  assert.equal(render({ type: 'result', tool: 'read_file', label: 'src/a.ts', ok: true }), undefined, 'a step that worked needs no second line');
  assert.match(render({ type: 'result', tool: 'run_terminal', label: 'npm test', ok: false, error: 'Exit 1' }).text, /✗ run_terminal npm test: Exit 1/);
  assert.match(render({ type: 'denied', what: 'command rm -rf build', hint: 'run with --allow-commands' }).text, /not allowed: command rm -rf build \(run with --allow-commands\)/);
  assert.match(render({ type: 'dialog', message: 'Codico wants to fetch a URL.\nhttps://x', answer: null }).text, /declined: Codico wants to fetch a URL\.\n$/);
  assert.equal(render({ type: 'dialog', message: 'x', answer: 'Allow Once' }), undefined);
  assert.match(render({ type: 'end', status: 'denied', denied: 2, requests: 5, tokens: 12345 }).text, /denied · 5 requests, 12,345 tokens · 2 not allowed/);
  assert.equal(render({ type: 'something-new' }), undefined);
});

test('in the extension: a dialog is allowed only where the command line said so', () => {
  const web = ['Allow Once', 'Allow External Actions This Turn'];
  assert.equal(dialogAnswer('Codico wants to fetch a URL.', web, {}), undefined);
  assert.equal(dialogAnswer('Codico wants to search the web.', web, { allowWeb: true }), 'Allow External Actions This Turn');
  const hook = ['Allow for This Workspace'];
  assert.equal(dialogAnswer('This project wants Codico to run a command as a beforeEdit hook.', hook, { allowWeb: true }), undefined, 'allowing the web does not allow hooks');
  assert.equal(dialogAnswer('This project wants Codico to run a command as a beforeEdit hook.', hook, { allowHooks: true }), 'Allow for This Workspace');
  // Everything else is dismissed, whatever was allowed: overwriting a changed file, starting an MCP server, merging, deleting
  for (const message of ['a.ts has changed since Codico made this change. Undo anyway and lose those changes?', 'Start the MCP server "db" defined by this workspace?', 'Discard this background task?', 'Open a pull request on acme/widgets?']) {
    assert.equal(dialogAnswer(message, ['Overwrite', 'Allow', 'Discard', 'Create Pull Request'], { allowWeb: true, allowHooks: true }), undefined, message);
  }
});

test('in the extension: the task file and the events', () => {
  const task = { prompt: 'do it', out: '/tmp/x.jsonl', permissions: 'edits' };
  assert.deepEqual(parseHeadlessTask(JSON.stringify(task)), task);
  for (const bad of ['', '{', '{}', JSON.stringify({ ...task, prompt: '  ' }), JSON.stringify({ ...task, out: '' }), JSON.stringify({ ...task, permissions: 'root' }), JSON.stringify({ ...task, permissions: undefined })]) { assert.equal(parseHeadlessTask(bad), undefined, bad); }
  assert.deepEqual(headlessEvent({ type: 'appendContent', id: 'm', text: 'Hello' }), { type: 'text', text: 'Hello' });
  assert.equal(headlessEvent({ type: 'appendContent', id: 'm', text: '' }), undefined);
  assert.deepEqual(headlessEvent({ type: 'toolResult', id: 'm', tool: 'edit_file', label: 'a.ts', success: false, error: 'not found' }), { type: 'result', tool: 'edit_file', label: 'a.ts', ok: false, error: 'not found' });
  assert.equal(headlessEvent({ type: 'appendThinking', id: 'm', text: 'private reasoning' }), undefined, 'reasoning is not part of the output');
  assert.equal(KEY_VARIABLES.DEEPSEEK_API_KEY, 'deepseek');
  // Headless only when the editor was started for it: an ordinary window never is, whatever the environment says
  process.env.CODICO_HEADLESS = '1';
  assert.equal(isHeadless({ extensionMode: 1 }), false);
  assert.equal(isHeadless({ extensionMode: 3 }), true);
  delete process.env.CODICO_HEADLESS;
  assert.equal(isHeadless({ extensionMode: 3 }), false);
});
