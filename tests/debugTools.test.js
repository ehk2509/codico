const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../out/debugTools.js');
const { parseToolCalls } = require('../out/toolParser.js');
const { nativeToolCallToToolCall } = require('../out/nativeTools.js');

test('the debug tool in both formats, with what each action needs', () => {
  assert.deepEqual(D.parseDebugFence('action: start\nprogram: debugme/run.js\nargs: --fast 3\nexceptions: uncaught\ntimeout_seconds: 30'),
    { type: 'debug', action: 'start', program: 'debugme/run.js', args: ['--fast', '3'], exceptions: 'uncaught', timeoutSeconds: 30 });
  assert.deepEqual(D.parseDebugFence('action: breakpoint\nfile: src/a.ts\nline: 12\ncondition: i > 3'), { type: 'debug', action: 'breakpoint', file: 'src/a.ts', line: 12, condition: 'i > 3' });
  assert.deepEqual(nativeToolCallToToolCall({ name: 'debug', arguments: { action: 'step', step: 'into' } }), { type: 'debug', action: 'step', step: 'into' });
  assert.deepEqual(nativeToolCallToToolCall({ name: 'debug', arguments: { action: 'start', command: 'npm test' } }), { type: 'debug', action: 'start', command: 'npm test' });
  assert.equal(D.debugToolFromArgs({ action: 'start' }), null, 'start needs something to run');
  assert.equal(D.debugToolFromArgs({ action: 'breakpoint', file: 'a.js' }), null, 'a breakpoint needs its line');
  assert.equal(D.debugToolFromArgs({ action: 'evaluate' }), null);
  assert.equal(D.debugToolFromArgs({ action: 'launch-rockets' }), null);
  assert.deepEqual(parseToolCalls('```debug\naction: continue\n```\n'), [{ type: 'debug', action: 'continue' }]);
  assert.equal(D.debugLabel({ type: 'debug', action: 'breakpoint', file: 'a.js', line: 3, remove: true }), 'remove breakpoint a.js:3');
});

test('an expression that only reads is evaluated without asking; one that could change something is asked for', () => {
  for (const ok of ['total', 'item.price * item.qty', 'items[0].qty === undefined', 'user["name"]', '(a + b) / 2', 'list.length > 3 && !done', "name === 'x(y)'"]) { assert.equal(D.readOnlyExpression(ok), true, ok); }
  for (const ask of ['save()', 'x = 3', 'count++', 'require("fs").rmSync("/")', 'new Date()', 'delete obj.a', 'await fetch(u)', 'arr.map(x => x)', '`${a}`', 'a; b', 'eval(s)', 'process.exit(1)']) { assert.equal(D.readOnlyExpression(ask), false, ask); }
});

test('a stop is reported with its place, source, call stack, variables and output; an end with its exit code', () => {
  const text = D.stopText({ reason: 'exception', description: 'Paused on exception', exception: 'Error: total is NaN',
    frames: [{ name: 'main', file: 'debugme/run.js', line: 3 }, { name: 'Module._compile', file: 'node:internal', line: 1 }],
    source: [[1, "const { total } = require('./calc');"], [2, 'const t = total(items);'], [3, "if (Number.isNaN(t)) throw new Error('total is NaN');"]],
    scopes: [{ name: 'Local', variables: [{ name: 't', value: 'NaN', type: 'number' }] }], output: ['start'] });
  assert.match(text, /^Stopped \(exception: Paused on exception\) in main at debugme\/run\.js:3\.\nException: Error: total is NaN\n\n {5}1  const \{ total \}[\s\S]*→ {4}3  if \(Number\.isNaN/);
  assert.match(text, /Call stack:\n  0\. main — debugme\/run\.js:3\n  1\. Module\._compile[\s\S]*Local:\n  t \(number\) = NaN\n\nRecent output:\n  start$/);
  assert.equal(D.endText(0, ['TOTAL 11']), 'The program ended with exit code 0.\nLast output:\n  TOTAL 11');
});

test('exit codes: each Node process of a debugged run writes its own; the one that exits last (the outermost) is the run\'s', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const cp = require('node:child_process');
  const Module = require('node:module');
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === 'vscode' ? {} : load.call(this, request, ...rest); };
  const { EXIT_HOOK, withExitHook, exitCodeOf } = require('../out/debugController.js');
  Module._load = load;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codico exit '));
  try {
    const hook = path.join(dir, 'exit-hook.js'); fs.writeFileSync(hook, EXIT_HOOK);
    assert.equal(withExitHook('--max-old-space-size=512', hook), `--max-old-space-size=512 --require ${JSON.stringify(hook)}`);
    const env = { ...process.env, NODE_OPTIONS: withExitHook(undefined, hook), CODICO_DEBUG_EXIT_DIR: dir };
    assert.equal(exitCodeOf(dir), undefined, 'none yet');
    // A process that ends on an uncaught error
    cp.spawnSync(process.execPath, ['-e', 'throw new Error("boom")'], { env });
    assert.equal(exitCodeOf(dir), 1);
    // A command whose child fails and which then exits with its own code (as npm does): the outer code is the run's
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.code'))) { fs.rmSync(path.join(dir, f)); }
    cp.spawnSync(process.execPath, ['-e', 'const r = require("child_process").spawnSync(process.execPath, ["-e", "process.exit(2)"]); setTimeout(() => process.exit(r.status === 2 ? 5 : 9), 30)'], { env });
    assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.code')).length, 2, 'both processes wrote theirs');
    assert.equal(exitCodeOf(dir), 5);
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.code'))) { fs.rmSync(path.join(dir, f)); }
    cp.spawnSync(process.execPath, ['-e', 'console.log("ok")'], { env });
    assert.equal(exitCodeOf(dir), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
