const test = require('node:test');
const assert = require('node:assert/strict');

const { runSubagent, runDelegate, subagentSystemPrompt, delegateResultText, SUBAGENT_TOOLS, SUBAGENT_MAX_REPORT_CHARS } = require('../out/subagent.js');
const { parseToolBody, scanToolFences } = require('../out/toolParser.js');
const { nativeToolCallToToolCall, getNativeToolDefinitions } = require('../out/nativeTools.js');
const { SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT } = require('../out/openRouterClient.js');

const F = '```';
// A scripted model: each entry is the chunks of one request; records what it was sent
function model(script) {
  const seen = [];
  return {
    seen,
    request(history, systemPrompt, tools) {
      const step = seen.length;
      seen.push({ history: JSON.parse(JSON.stringify(history)), systemPrompt, tools: tools.map(t => t.name) });
      const chunks = script[step] ?? [{ type: 'content', text: 'Nothing more.' }];
      return (async function* () { for (const c of chunks) { yield c; } })();
    },
  };
}
const call = (name, args, id) => ({ type: 'native_tool', call: { id, name, arguments: args } });
const noAbort = new AbortController().signal;

test('a subagent reads in its own conversation and returns only its report', async () => {
  const m = model([
    [{ type: 'content', text: 'Looking.' }, call('search_files', { pattern: 'retry' }, 'a'), call('read_file', { filepath: 'src/net.ts' }, 'b'), { type: 'usage', promptTokens: 900, completionTokens: 20, totalTokens: 920 }],
    [{ type: 'content', text: 'The retry loop is in src/net.ts:42; it retries 3 times.' }, { type: 'usage', promptTokens: 1500, completionTokens: 30, totalTokens: 1530 }],
  ]);
  const ran = []; const usage = [];
  const result = await runSubagent('Find where requests are retried.', { request: m.request, nativeTools: true, signal: noAbort, onUsage: u => usage.push(u.totalTokens),
    runTool: async t => { ran.push(t.type); return `RESULT of ${t.type}`; } });
  assert.deepEqual(result, { report: 'The retry loop is in src/net.ts:42; it retries 3 times.', requests: 2, toolCalls: 2, outcome: 'done' });
  assert.deepEqual(ran, ['search_files', 'read_file']);
  assert.deepEqual(usage, [920, 1530]);
  // Its own conversation: the task, then its calls and their results
  assert.deepEqual(m.seen[0].history, [{ role: 'user', content: '[Delegated task]\nFind where requests are retried.' }]);
  assert.deepEqual(m.seen[1].history.map(h => h.role), ['user', 'assistant', 'tool', 'tool']);
  assert.equal(m.seen[1].history[2].content, 'RESULT of search_files');
  // Only tools that read: no edits, no commands, no web, no delegating further
  assert.deepEqual(m.seen[0].tools.sort(), [...SUBAGENT_TOOLS].sort());
  for (const forbidden of ['edit_file', 'write_file', 'run_terminal', 'delegate', 'fetch_url', 'mcp_call']) { assert.equal(m.seen[0].tools.includes(forbidden), false, forbidden); }
});

test('a tool a subagent may not use is refused, and it carries on', async () => {
  const m = model([
    [call('edit_file', { filepath: 'a.ts', old_str: 'x', new_str: 'y' }, 'a'), call('run_terminal', { command: 'rm -rf .' }, 'b'), call('delegate', { task: 'more' }, 'c')],
    [{ type: 'content', text: 'I can only read: nothing was changed.' }],
  ]);
  const ran = [];
  const result = await runSubagent('Change a.ts', { request: m.request, nativeTools: true, signal: noAbort, runTool: async t => { ran.push(t.type); return 'x'; } });
  assert.deepEqual(ran, [], 'nothing was executed');
  assert.equal(result.toolCalls, 0);
  const refusals = m.seen[1].history.filter(h => h.role === 'tool').map(h => h.content);
  assert.equal(refusals.length, 3);
  assert.ok(refusals.every(text => /Not available to a subagent: it can only read and search/.test(text)));
  assert.equal(result.outcome, 'done');
});

test('the text tool format: fenced calls run, and their results come back together', async () => {
  const m = model([
    [{ type: 'content', text: `Two looks.\n\n${F}read_file\nfilepath: a.ts\n${F}\n\n${F}search_files\npattern: retry\n${F}\n\n${F}write_file\nfilepath: b.ts\ncontent:\nx\n${F}\n` }],
    [{ type: 'content', text: 'Report: found it.' }],
  ]);
  const ran = [];
  const result = await runSubagent('Look.', { request: m.request, nativeTools: false, signal: noAbort, runTool: async t => { ran.push(t.type); return `R-${t.type}`; } });
  assert.deepEqual(ran, ['read_file', 'search_files']);
  assert.deepEqual(m.seen[0].tools, [], 'no native tool definitions in the text format');
  const back = m.seen[1].history[2];
  assert.equal(back.role, 'user');
  assert.match(back.content, /^\[Tool Results\]\n\nR-read_file\n\n---\n\nR-search_files\n\n---\n\n\[write_file\] Not available to a subagent/);
  assert.deepEqual([result.report, result.toolCalls, result.requests], ['Report: found it.', 2, 2]);
});

test('out of steps: one more request, without tools, for the report', async () => {
  const looping = Array.from({ length: 3 }, (_, i) => [call('read_file', { filepath: `f${i}.ts` }, `c${i}`)]);
  const m = model([...looping, [{ type: 'content', text: 'Partial: read three files, the answer is probably in f2.ts.' }]]);
  const result = await runSubagent('Find it.', { request: m.request, nativeTools: true, signal: noAbort, maxSteps: 3, runTool: async () => 'content' });
  assert.equal(result.outcome, 'step-limit');
  assert.equal(result.requests, 4);
  assert.equal(result.report, 'Partial: read three files, the answer is probably in f2.ts.');
  const last = m.seen[3];
  assert.deepEqual(last.tools, [], 'no tools on the last request');
  assert.match(last.history[last.history.length - 1].content, /You have used all your steps\. Do not call any tool\. Write your report now/);
  assert.match(delegateResultText('Find it.', result), /It ran out of steps: the report may be incomplete\./);
});

test('stopping, a failed request and a thrown error all end with a result, never an exception', async () => {
  const controller = new AbortController();
  const m = model([[call('read_file', { filepath: 'a.ts' }, 'a')], [{ type: 'content', text: 'never' }]]);
  const stopped = await runSubagent('x', { request: m.request, nativeTools: true, signal: controller.signal, runTool: async () => { controller.abort(); return 'r'; } });
  assert.equal(stopped.outcome, 'stopped');
  assert.equal(m.seen.length, 1, 'no further request after Stop');

  const failing = model([[{ type: 'stream_error', message: 'HTTP 500' }]]);
  const failed = await runSubagent('x', { request: failing.request, nativeTools: true, signal: noAbort, runTool: async () => 'r' });
  assert.deepEqual([failed.outcome, failed.report], ['failed', "The subagent's request failed: HTTP 500"]);

  const throwing = { request() { throw new Error('no key'); } };
  const thrown = await runSubagent('x', { request: throwing.request, nativeTools: true, signal: noAbort, runTool: async () => 'r' });
  assert.deepEqual([thrown.outcome, thrown.report], ['failed', 'The subagent failed: no key']);
});

test('a long report is cut; the main agent is told the reads are not in its conversation', async () => {
  const m = model([[{ type: 'content', text: 'x'.repeat(SUBAGENT_MAX_REPORT_CHARS + 500) }]]);
  const result = await runSubagent('x', { request: m.request, nativeTools: true, signal: noAbort, runTool: async () => 'r' });
  assert.ok(result.report.length < SUBAGENT_MAX_REPORT_CHARS + 80);
  assert.match(result.report, /… \(report cut at 8,000 characters\)$/);
  const text = delegateResultText('Find where requests are retried.\nAnd more.', { report: 'In src/net.ts:42.', requests: 3, toolCalls: 5, outcome: 'done' });
  assert.match(text, /^\[delegate\] The subagent has reported \(3 requests, 5 tool calls\)\. Its reads are not in this conversation/);
  assert.match(text, /\nTask: Find where requests are retried\.\n\n## Subagent report\n\nIn src\/net\.ts:42\.$/);
});

test('the subagent prompt: read-only tools, the rules, and a project agent as its role', () => {
  const plain = subagentSystemPrompt();
  assert.ok(plain.startsWith(CHAT_SYSTEM_PROMPT));
  assert.match(plain, /## You are a subagent/);
  assert.match(plain, /it only receives your final message/);
  assert.doesNotMatch(plain, /```delegate|write_file\nfilepath/);
  const role = subagentSystemPrompt({ name: 'reviewer', instructions: 'Look for security problems first.' });
  assert.match(role, /## Your role: reviewer\n\nLook for security problems first\.$/);
});

test('delegate with a project agent: the agent is found by name, an unknown one is an error the model can fix', async () => {
  const m = model([[{ type: 'content', text: 'Reviewed: fine.' }]]);
  const host = { request: m.request, nativeTools: true };
  const agents = [{ name: 'reviewer', instructions: 'Be strict.' }];
  const run = { signal: noAbort, runTool: async () => 'r' };
  const ok = await runDelegate({ task: 'Review src/a.ts\nfor bugs', agent: '@Reviewer' }, host, agents, run);
  assert.equal(ok.success, true);
  assert.equal(ok.label, 'Review src/a.ts — 1 request, 0 tool calls');
  assert.match(m.seen[0].systemPrompt, /## Your role: reviewer\n\nBe strict\.$/);
  const unknown = await runDelegate({ task: 'x', agent: 'ghost' }, host, agents, run);
  assert.equal(unknown.success, false);
  assert.match(unknown.text, /there is no project agent named "ghost"\. The project's agents are: reviewer\./);
  assert.equal(m.seen.length, 1, 'no request was made for the unknown agent');
  const none = await runDelegate({ task: 'x', agent: 'ghost' }, host, [], run);
  assert.match(none.text, /This project defines no agents\./);
  // Outside a running task there is nothing to delegate from
  assert.equal((await runDelegate({ task: 'x' }, undefined, [], run)).success, false);
});

test('the delegate tool in both formats', () => {
  const fence = scanToolFences(`${F}delegate\nagent: reviewer\ntask:\nFind every caller of retry().\nnote: report file:line for each.\n${F}\n`, 0, true).fences[0];
  assert.deepEqual(parseToolBody(fence.type, fence.body), [{ type: 'delegate', task: 'Find every caller of retry().\nnote: report file:line for each.', agent: 'reviewer' }]);
  assert.deepEqual(parseToolBody('delegate', 'task: one line'), [{ type: 'delegate', task: 'one line' }]);
  assert.deepEqual(parseToolBody('delegate', 'agent: reviewer'), [], 'no task: not a call');
  assert.deepEqual(nativeToolCallToToolCall({ name: 'delegate', arguments: { task: 'Find it', agent: 'db' } }), { type: 'delegate', task: 'Find it', agent: 'db' });
  assert.equal(nativeToolCallToToolCall({ name: 'delegate', arguments: {} }), null);
  // Offered to the agent in both modes (it is read-only), and documented in the agent's prompt
  assert.ok(getNativeToolDefinitions(false).some(t => t.name === 'delegate'));
  assert.ok(getNativeToolDefinitions(true).some(t => t.name === 'delegate'));
  assert.match(SYSTEM_PROMPT, /```delegate\nagent: <optional project agent name>\ntask:/);
  assert.match(SYSTEM_PROMPT, /use delegate: a subagent reads in a conversation of its own/);
  const rules = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf('## Rules')).match(/^\d+(?=\. )/gm).map(Number);
  assert.deepEqual(rules, rules.map((_, i) => i + 1));
});

test('a tool call in a syntax Codico does not read is not taken for the report', async () => {
  const xml = '<invoke name="search_files">\n<parameter name="pattern">compact</parameter>\n</invoke>\n\nTool Results:\n[search_files] No matches found.';
  const m = model([
    [{ type: 'content', text: xml }],
    [{ type: 'content', text: `${F}search_files\npattern: compact\n${F}\n` }],
    [{ type: 'content', text: 'Report: compaction is in src/historyCompaction.ts.' }],
  ]);
  const ran = [];
  const result = await runSubagent('Find compaction.', { request: m.request, nativeTools: false, signal: noAbort, runTool: async t => { ran.push(t.type); return 'real result'; } });
  assert.deepEqual(ran, ['search_files']);
  assert.equal(result.report, 'Report: compaction is in src/historyCompaction.ts.');
  assert.match(m.seen[1].history[2].content, /That was not a tool call Codico can run, so nothing was executed and any results you wrote are not real/);
  // It is corrected twice at most; after that what it wrote is returned as it is
  const stubborn = model([[{ type: 'content', text: xml }], [{ type: 'content', text: xml }], [{ type: 'content', text: xml }]]);
  const gaveUp = await runSubagent('x', { request: stubborn.request, nativeTools: false, signal: noAbort, runTool: async () => 'r' });
  assert.equal(gaveUp.requests, 3);
  assert.equal(gaveUp.outcome, 'done');
});

test('both prompts spell out the tool call format', () => {
  for (const prompt of [SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT]) {
    assert.match(prompt, /Invoke tools using these exact fenced-code-block formats\./);
    assert.match(prompt, /Never write a tool call in any other syntax \(no XML or JSON\), and never write tool results yourself\./);
  }
});

