// A stand-in for OpenAI's `codex` command in tests. It prints the JSONL the real CLI (0.162.1)
// prints for `codex exec --json`, and records how it was called in the file named by FAKE_CODEX_LOG.
//   FAKE_CODEX_MODE: (default) reply | signed-out | no-features | slow
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE || 'reply';
const record = (entry) => { if (process.env.FAKE_CODEX_LOG) { fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(entry) + '\n'); } };

if (args[0] === 'features') {
  record({ args });
  if (mode === 'no-features') { process.exit(2); }
  process.stdout.write([
    'apps                                     stable             true',
    'goals                                    stable             true',
    'shell_tool                               stable             true',
    'unified_exec                             stable             true',
    'view_image                               stable             true',
    'undo                                     stable             false',
  ].join('\n') + '\n');
  process.exit(0);
}

// Like the real CLI: an unknown feature name is refused
const known = ['apps', 'goals', 'shell_tool', 'unified_exec', 'view_image', 'undo'];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--disable' && !known.includes(args[i + 1])) { process.stderr.write(`Error: Unknown feature flag: ${args[i + 1]}\n`); process.exit(1); }
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { prompt += d; });
process.stdin.on('end', () => {
  const config = Object.fromEntries(args.map((a, i) => args[i - 1] === '-c' ? a.split(/=(.*)/s).slice(0, 2) : null).filter(Boolean));
  let instructions = null;
  try { instructions = fs.readFileSync(JSON.parse(config.model_instructions_file), 'utf8'); } catch { /* recorded as null */ }
  record({ args, prompt, instructions, cwd: process.cwd(), apiKey: process.env.OPENAI_API_KEY || null });
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'thread.started', thread_id: 't1' });
  out({ type: 'turn.started' });
  if (mode === 'slow') { setTimeout(() => {}, 60000); return; }
  if (mode === 'signed-out') {
    process.stderr.write('2026-10-10T09:05:48Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized\n');
    out({ type: 'error', message: 'Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header)' });
    out({ type: 'error', message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' });
    out({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' } });
    process.exitCode = 1;
    return;
  }
  // Agent scenario: first ask for a tool in Codico's fenced format, then answer from its result
  const F = '```';
  // Decided by the last user turn (the transcript may hold earlier, unrelated turns)
  const last = prompt.slice(prompt.lastIndexOf('<user>') + 1);
  const reply = /\[Tool Results\]/.test(last)
    ? 'The notes say: ' + (/(NOTES-MARKER)/.exec(last) || ['(nothing)'])[0]
    : /SCENARIO:cx_tools/.test(last) ? `Reading the notes.\n\n${F}read_file\nfilepath: fixtures/notes.txt\n${F}\n` : 'PONG';
  out({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Working it out**' } });
  out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: reply } });
  out({ type: 'turn.completed', usage: { input_tokens: 1800, cached_input_tokens: 1200, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 2 } });
});
