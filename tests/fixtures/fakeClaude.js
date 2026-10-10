// A stand-in for the `claude` command in tests. It prints the stream-json lines the real CLI
// (2.1.295) prints for `claude -p --output-format stream-json --verbose --include-partial-messages`,
// and records how it was called in the file named by FAKE_CLAUDE_LOG.
//   FAKE_CLAUDE_MODE: (default) reply | signed-out | api-error | slow
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || 'reply';
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { prompt += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_CLAUDE_LOG) {
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt, cwd: process.cwd(), nested: process.env.CLAUDECODE || null }) + '\n');
  }
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  if (mode === 'signed-out') { process.stderr.write('Invalid API key · Please run /login\n'); process.exit(1); }
  if (mode === 'slow') { setTimeout(() => {}, 60000); return; }
  out({ type: 'system', subtype: 'init', session_id: 's1', cwd: process.cwd() });
  if (mode === 'api-error') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: overloaded', usage: { input_tokens: 0, output_tokens: 0 } });
    return;
  }
  // Agent scenario: first ask for a tool in Codico's fenced format, then answer from its result
  const F = '```';
  // Decided by the last user turn (the transcript may hold earlier, unrelated turns)
  const last = prompt.slice(prompt.lastIndexOf('<user>') + 1);
  const reply = /\[Tool Results\]/.test(last)
    ? 'The notes say: ' + (/(NOTES-MARKER)/.exec(last) || ['(nothing)'])[0]
    : /SCENARIO:cc_tools/.test(last) ? `Reading the notes.\n\n${F}read_file\nfilepath: fixtures/notes.txt\n${F}\n` : 'PONG';
  const delta = (d) => out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: d } });
  out({ type: 'stream_event', event: { type: 'message_start' } });
  delta({ type: 'thinking_delta', thinking: 'Working it out.' });
  for (const part of reply.match(/[\s\S]{1,9}/g)) { delta({ type: 'text_delta', text: part }); }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
  out({ type: 'stream_event', event: { type: 'message_stop' } });
  out({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: reply, total_cost_usd: 0.00025,
    usage: { input_tokens: 2, cache_creation_input_tokens: 613, cache_read_input_tokens: 1200, output_tokens: 5 } });
});
