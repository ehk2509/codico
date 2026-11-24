const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codico verify '));
const vscodeStub = {
  workspace: { workspaceFolders: [{ uri: { fsPath: root, scheme: 'file' }, name: 'ws', index: 0 }], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  Uri: { file: p => ({ fsPath: p, scheme: 'file' }) },
  commands: { executeCommand: async () => undefined },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain); };
test.after(() => { Module._load = originalLoad; fs.rmSync(root, { recursive: true, force: true }); });

const { VerifyRuntime, REVIEW_DISPUTE_PREFIX } = require('../out/verifyRuntime.js');
const { PassportRecorder } = require('../out/patchPassport.js');

function setup(answers) {
  const passport = new PassportRecorder();
  const external = { browser: {}, onBrowserStep: undefined };
  const runtime = new VerifyRuntime({ post: () => {}, passport: () => passport, tools: {}, external });
  const calls = [];
  const reviewer = { request: (history) => { calls.push(history); const text = answers.shift() ?? ''; return (async function* () { yield { type: 'content', text }; })(); } };
  runtime.beginTurn(root, 'Name the workers: "Backend API" becomes backend-api in the fenced form and in start.');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/team.ts'), 'export const clean = (s) => s;\n');
  passport.recordChange('src/team.ts', 'export {}\n', 'export const clean = (s) => s;\n');
  return { runtime, passport, reviewer, calls };
}

test('Codico\'s own preflight asks once for missing criteria and leaves the reviewer\'s disputes for the reviewer', async () => {
  const { runtime, passport, reviewer, calls } = setup(['AC1: no — the fenced form is not tested.\nREQUEST: no — `start` with "Backend API" is not tested.']);
  const signal = new AbortController().signal;
  // The request check comes first, as before
  assert.match(await runtime.guidanceBeforeEnd(reviewer, true, signal), /show that the request itself is met/);
  // No criteria: Codico asks for them itself, without a paid review call, once
  assert.match(await runtime.guidanceBeforeEnd(reviewer, true, signal), /^\[System Acceptance\] Codico cannot review this work yet: No acceptance criteria registered/);
  assert.equal(await runtime.guidanceBeforeEnd(reviewer, true, signal), undefined, 'asked once, not again');
  assert.equal(calls.length, 0, 'no reviewer call while the evidence is missing');
  // The agent states and verifies a criterion: now the reviewer is called, and its dispute reaches the agent
  passport.acceptance.setCriteria(['"Backend API" becomes backend-api in the fenced form']);
  const evidence = passport.recordCommand('node --test tests/team.test.js', 0, '# pass 3\n# fail 0\n');
  passport.acceptance.claim('AC1', 'pass', 'test', [evidence]);
  const dispute = await runtime.guidanceBeforeEnd(reviewer, true, signal);
  assert.equal(calls.length, 1);
  assert.ok(dispute.startsWith(REVIEW_DISPUTE_PREFIX), dispute);
  assert.match(dispute, /the fenced form is not tested/);
});

test('criteria stated but not verified: the paid review is skipped without a second nag on top of the reminders', async () => {
  const { runtime, passport, reviewer, calls } = setup([]);
  const signal = new AbortController().signal;
  passport.acceptance.setCriteria(['"Backend API" becomes backend-api']);
  passport.recordCommand('node --test tests/team.test.js', 0, '# pass 3\n# fail 0\n'); // evidence exists, but the criterion is not recorded as met
  const seen = [];
  for (let i = 0; i < 6; i++) { seen.push(await runtime.guidanceBeforeEnd(reviewer, true, signal)); }
  assert.equal(calls.length, 0, 'no reviewer call before the criteria are verified');
  assert.ok(!seen.some(text => /Codico cannot review this work yet/.test(text ?? '')), 'the reminders already said it');
  assert.ok(seen.some(text => /Not verified on the final code yet/.test(text ?? '')), 'the usual reminder still comes');
});
