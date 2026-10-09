const test = require('node:test');
const assert = require('node:assert/strict');
const { planCompaction, summarizerPrompt, buildCompactedHistory, isUserRequest } = require('../out/historyCompaction.js');

const user = (content) => ({ role: 'user', content });
const assistant = (content, calls) => ({ role: 'assistant', content, ...(calls ? { nativeToolCalls: calls } : {}) });
let n = 0;
const nativeStep = (name, args, result) => {
  const id = `call_${++n}`;
  return [assistant('', [{ id, name, arguments: args }]), { role: 'tool', content: result, toolCallId: id, toolName: name }];
};

/** Every tool result must follow the assistant message that issued its call; roles must alternate. */
function assertWellFormed(history) {
  const issued = new Set();
  history.forEach((m, i) => {
    if (m.role === 'assistant') { (m.nativeToolCalls || []).forEach(c => issued.add(c.id)); }
    if (m.role === 'tool') { assert.ok(issued.has(m.toolCallId), `tool result at ${i} has no preceding call`); }
    if (i > 0 && m.role !== 'tool' && history[i - 1].role !== 'tool') {
      assert.notEqual(m.role, history[i - 1].role, `two ${m.role} messages in a row at ${i}`);
    }
  });
  assert.equal(history[0].role, 'user');
}

// The reported case: a long earlier thread, then a Plan request followed by many native tool calls
function reportedThread() {
  const old = [];
  for (let t = 0; t < 12; t++) {
    old.push(user(`[Context]\nWorkspace: /ws\n\nBuild crypto bot feature ${t}`), assistant(`Built crypto feature ${t}. ` + 'x'.repeat(4000)));
  }
  const request = user('[Context]\nWorkspace: /ws\nOpen tabs (3):\n// README.md\n# Title\n\nSome tab text\n\n[User request]\nYou are a task planner…\n\nGoal: plan for codico new features');
  const steps = [];
  for (let s = 0; s < 18; s++) { steps.push(...nativeStep('read_file', { filepath: `src/f${s}.ts` }, `[read_file: src/f${s}.ts]\n` + 'y'.repeat(3000))); }
  return { history: [...old, request, ...steps], request };
}

test('compaction keeps the current request verbatim and never starts the tail inside a tool exchange', () => {
  const { history, request } = reportedThread();
  const plan = planCompaction(history);
  assert.equal(plan.request, request, 'the active request is kept as-is');
  assert.equal(plan.tail[0].role, 'assistant', 'tail starts at an assistant step');
  assert.equal(plan.tail.length, 8, '4 most recent complete exchanges');
  assert.equal(plan.earlier.length, 24);
  assert.equal(plan.progress.length, 28, 'older steps of the current turn are summarised');

  const compacted = buildCompactedHistory('SUMMARY', plan);
  assertWellFormed(compacted);
  assert.ok(compacted.includes(request));
  assert.match(compacted[0].content, /^\[Conversation Summary\]\n\nSUMMARY/);
});

test('the summary prompt names the current request and prefers recent work', () => {
  const { history } = reportedThread();
  const prompt = summarizerPrompt(planCompaction(history), 12000);
  assert.match(prompt, /## Current request \(kept separately\)\nYou are a task planner…\n\nGoal: plan for codico new features/);
  assert.doesNotMatch(prompt.split('## Earlier conversation')[0], /Open tabs/, 'injected [Context] is left out of the request');
  assert.match(prompt, /Built crypto feature 11/, 'most recent earlier turn kept');
  assert.doesNotMatch(prompt, /Built crypto feature 0\b/, 'oldest turns are what gets dropped');
  assert.match(prompt, /older message\(s\) omitted/);
  assert.match(prompt, /## Progress so far on the current request/);
  assert.match(prompt, /read_file \{"filepath":"src\/f13\.ts"\}/, 'tool calls of the summarised steps are described');
});

test('tool results, Codico reminders and earlier summaries are not mistaken for the request', () => {
  assert.equal(isUserRequest(user('[Tool Results]\n\n[read_file: a]')), false);
  assert.equal(isUserRequest(user('[System Verification] verify it')), false);
  assert.equal(isUserRequest(user('[Conversation Summary]\n\nold')), false);
  assert.equal(isUserRequest(user('[Context]\nWorkspace: /ws\n\nfix the bug')), true);

  // Fenced (compatibility) tool loop: results come back as [Tool Results] user messages
  const request = user('Fix the parser');
  const history = [user('earlier question'), assistant('earlier answer'), request];
  for (let s = 0; s < 6; s++) { history.push(assistant('```read_file\nfilepath: a\n```'), user('[Tool Results]\n\nresult ' + s)); }
  history.push(assistant('Done.'), user('[System Verification] You changed code…'));
  const plan = planCompaction(history);
  assert.equal(plan.request, request);
  assertWellFormed(buildCompactedHistory('S', plan));
});

test('nothing to compact returns null; a second compaction folds the first summary in', () => {
  assert.equal(planCompaction([user('hi'), assistant('hello')]), null);

  const { history } = reportedThread();
  const once = buildCompactedHistory('FIRST SUMMARY', planCompaction(history));
  once.push(...nativeStep('read_file', { filepath: 'x' }, 'z'.repeat(70000)), ...nativeStep('read_file', { filepath: 'w' }, 'z'.repeat(70000)));
  const plan = planCompaction(once);
  assert.match(plan.request.content, /Goal: plan for codico new features/, 'request still found after a previous compaction');
  assert.ok(plan.earlier.some(m => /FIRST SUMMARY/.test(m.content)), 'previous summary is re-summarised, not kept twice');
  assertWellFormed(buildCompactedHistory('SECOND', plan));
});

test('a history with no identifiable request (as left by the old compaction) is repaired', () => {
  // The broken shape from the report: summary, then a tool result whose call was cut off
  const broken = [user('[Conversation Summary]\n\nold'), { role: 'tool', content: 'orphan', toolCallId: 'gone', toolName: 'read_file' }];
  for (let s = 0; s < 6; s++) { broken.push(...nativeStep('search_files', { pattern: 'p' + s }, 'r')); }
  const plan = planCompaction(broken);
  assert.equal(plan.request, null);
  const compacted = buildCompactedHistory('S', plan);
  assertWellFormed(compacted);
  assert.ok(!compacted.some(m => m.toolCallId === 'gone'), 'orphaned tool result dropped');
});

test('the user\'s own words are separated from injected context, with and without the marker', () => {
  const { userRequestText } = require('../out/historyCompaction.js');
  assert.equal(userRequestText(user('[Context]\nOpen tabs:\n// a.md\n# A\n\ntext\n\n[User request]\nPara one.\n\nPara two.')), 'Para one.\n\nPara two.');
  // Older messages without the marker: the user's text is at the end
  const old = '[Context]\n' + 'c'.repeat(5000) + '\n\nfix the login bug';
  assert.match(userRequestText(user(old), 100), /fix the login bug$/);
  assert.equal(userRequestText(user('plain request')), 'plain request');
});
