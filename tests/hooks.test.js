const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// A stand-in for VS Code over a real temporary folder: hooks are real commands
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-hooks-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const uri = (p) => ({ scheme: 'file', path: p.split(path.sep).join('/'), fsPath: p, toString: () => `file://${p}` });
const folder = { name: 'project', uri: uri(root), index: 0 };
const dialogs = [];
const warnings = [];
let answer;
let trusted = true;
const state = new Map();
const vscodeStub = {
  Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)), file: (p) => uri(p) },
  workspace: {
    get workspaceFolders() { return [folder]; },
    get isTrusted() { return trusted; },
    getWorkspaceFolder: () => folder,
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
    fs: { readFile: async (u) => fs.readFileSync(u.fsPath), stat: async (u) => fs.statSync(u.fsPath), writeFile: async (u, bytes) => { fs.mkdirSync(path.dirname(u.fsPath), { recursive: true }); fs.writeFileSync(u.fsPath, bytes); } },
  },
  window: {
    showWarningMessage: async (message, options, ...buttons) => { if (options && options.modal) { dialogs.push({ message, detail: options.detail, buttons }); return answer; } warnings.push(message); return undefined; },
    showErrorMessage: async () => undefined,
    showTextDocument: async () => undefined,
  },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain); };
test.after(() => { Module._load = originalLoad; });

const { parseHooks, matcher, hooksFor, hookSubject, hookFingerprint, hookCommandLine, shellQuote, hookInput, toolOutcome, refusalText, reportText, HOOKS_TEMPLATE } = require('../out/hooks.js');
const { HookRunner, createHooksFile, APPROVED_HOOKS_KEY } = require('../out/hookRunner.js');

const memento = { get: (k, d) => state.get(k) ?? d, update: async (k, v) => { state.set(k, v); } };
const noAbort = new AbortController().signal;
const edit = (filepath) => ({ type: 'edit_file', filepath, oldStr: 'a', newStr: 'b' });
const write = (filepath, content = 'x') => ({ type: 'write_file', filepath, content });
const run = (command) => ({ type: 'run_terminal', command });
// Hook commands are small Node scripts in the project, so they behave the same on every platform
const script = (name, body) => { fs.writeFileSync(path.join(root, name), body); return `node ${name}`; };
function project(hooks) {
  fs.mkdirSync(path.join(root, '.codico'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codico', 'hooks.json'), typeof hooks === 'string' ? hooks : JSON.stringify({ hooks }));
  state.clear(); dialogs.length = 0; warnings.length = 0; answer = 'Allow for This Workspace'; trusted = true;
  return new HookRunner(() => memento);
}

test('the hooks file: valid entries are used, and each bad one is named', () => {
  const { hooks, problems } = parseHooks(JSON.stringify({ hooks: [
    { event: 'afterEdit', match: '**/*.ts', name: 'lint', command: 'npx eslint {file}', timeoutSeconds: 60 },
    { event: 'beforeCommand', command: '  exit 1  ' },
    { event: 'onSave', command: 'x' },
    { event: 'afterEdit' },
    { event: 'afterEdit', command: 'x', timeoutSeconds: -1 },
    { event: 'afterEdit', command: 'x', match: '' },
    'nope',
    { event: 'afterCommand', command: 'x', timeoutSeconds: 99999 },
  ] }));
  assert.deepEqual(hooks, [
    { event: 'afterEdit', command: 'npx eslint {file}', match: '**/*.ts', name: 'lint', timeoutSeconds: 60 },
    { event: 'beforeCommand', command: 'exit 1', timeoutSeconds: 30 },
    { event: 'afterCommand', command: 'x', timeoutSeconds: 600 },
  ]);
  assert.deepEqual(problems, [
    'hooks[2]: "event" must be one of beforeEdit, afterEdit, beforeCommand, afterCommand',
    'hooks[3]: "command" is required',
    'hooks[4]: "timeoutSeconds" must be a positive number',
    'hooks[5]: "match" must be a non-empty string',
    'hooks[6]: must be an object',
  ]);
  assert.match(parseHooks('{ broken').problems[0], /^hooks\.json is not valid JSON/);
  assert.deepEqual(parseHooks('{"other":1}').problems, ['hooks.json must be { "hooks": [ … ] }']);
  // A bare list is accepted too, and the template the command writes is valid
  assert.equal(parseHooks('[{"event":"afterEdit","command":"x"}]').hooks.length, 1);
  assert.deepEqual(parseHooks(HOOKS_TEMPLATE).problems, []);
  assert.equal(parseHooks(JSON.stringify({ hooks: Array.from({ length: 25 }, () => ({ event: 'afterEdit', command: 'x' })) })).hooks.length, 20);
});

test('which files and commands a hook is for', () => {
  const file = (glob, p) => matcher(glob, 'file').test(p);
  assert.ok(file('**/*.ts', 'src/a/b.ts') && file('**/*.ts', 'b.ts') && !file('**/*.ts', 'b.tsx'));
  assert.ok(file('*.md', 'docs/guide.md'), 'a pattern without a folder is a file name anywhere');
  assert.ok(file('src/*.ts', 'src/a.ts') && !file('src/*.ts', 'src/a/b.ts'));
  assert.ok(file('migrations/**', 'migrations/2026/001.sql') && !file('migrations/**', 'src/migrations.ts'));
  assert.ok(file('package.json', 'package.json') && file('package.json', 'web/package.json') && !file('package.json', 'package-json'));
  const command = (glob, c) => matcher(glob, 'command').test(c);
  assert.ok(command('git push*', 'git push origin main') && !command('git push*', 'echo git push'));
  assert.ok(command('*npm test*', 'cd web && npm test -- --watch=false') && command('npm test', 'npm test') && !command('npm test', 'npm test:ui'));
  assert.ok(command('rm -rf (x)*', 'rm -rf (x) y'), 'everything but * is literal');

  const hooks = parseHooks(JSON.stringify({ hooks: [{ event: 'beforeEdit', match: 'migrations/**', command: 'a' }, { event: 'afterEdit', command: 'b' }, { event: 'beforeCommand', match: 'git push*', command: 'c' }] })).hooks;
  assert.deepEqual(hookSubject(edit('./migrations/1.sql')), { before: 'beforeEdit', after: 'afterEdit', kind: 'file', subject: 'migrations/1.sql' });
  assert.deepEqual(hookSubject(run(' git push ')), { before: 'beforeCommand', after: 'afterCommand', kind: 'command', subject: 'git push' });
  assert.equal(hookSubject({ type: 'read_file', filepath: 'a' }), null, 'reading is not covered by hooks');
  assert.deepEqual(hooksFor(hooks, 'beforeEdit', 'file', 'migrations/1.sql').map(h => h.command), ['a']);
  assert.deepEqual(hooksFor(hooks, 'beforeEdit', 'file', 'src/a.ts'), []);
  assert.deepEqual(hooksFor(hooks, 'afterEdit', 'file', 'src/a.ts').map(h => h.command), ['b'], 'no match: every file');
});

test('a hook is told what happened, and a file name cannot break out of its command', () => {
  const hook = parseHooks('[{"event":"afterEdit","command":"npx eslint {file} && echo {file}"}]').hooks[0];
  assert.equal(hookCommandLine(hook, "src/it's $(reboot);.ts", 'linux'), "npx eslint 'src/it'\\''s $(reboot);.ts' && echo 'src/it'\\''s $(reboot);.ts'");
  assert.equal(shellQuote('a "b" %PATH% c.ts', 'win32'), '"a b PATH c.ts"');
  const input = hookInput(hook, write('src/a.ts', 'const a = 1;'));
  assert.deepEqual(input.json, { event: 'afterEdit', tool: 'write_file', file: 'src/a.ts', content: 'const a = 1;' });
  assert.deepEqual(input.env, { CODICO_HOOK_EVENT: 'afterEdit', CODICO_HOOK_TOOL: 'write_file', CODICO_HOOK_FILE: 'src/a.ts', CODICO_HOOK_COMMAND: '' });
  const after = hookInput({ ...hook, event: 'afterCommand' }, run('npm test'), { exitCode: 1, output: 'boom' });
  assert.deepEqual(after.json, { event: 'afterCommand', tool: 'run_terminal', command: 'npm test', exitCode: 1, output: 'boom' });
  assert.equal(after.env.CODICO_HOOK_EXIT_CODE, '1');
  assert.deepEqual(hookInput(hook, edit('a.ts')).json, { event: 'afterEdit', tool: 'edit_file', file: 'a.ts', oldText: 'a', newText: 'b' });
  // A changed command is another hook: it has to be allowed again
  assert.notEqual(hookFingerprint(hook), hookFingerprint({ ...hook, command: 'rm -rf .' }));
  assert.equal(hookFingerprint(hook), hookFingerprint({ ...hook, name: 'renamed' }));
});

test('only a call that did what it was asked has an "after"', () => {
  assert.deepEqual(toolOutcome(edit('a.ts'), '[edit_file: a.ts] Edit applied successfully.\nResult (lines 1–3…'), { succeeded: true });
  assert.deepEqual(toolOutcome(edit('a.ts'), '[edit_file: a.ts] ERROR: old_str not found'), { succeeded: false });
  assert.deepEqual(toolOutcome(write('a.ts'), '[write_file: a.ts] Written successfully (3 lines).'), { succeeded: true });
  assert.deepEqual(toolOutcome(write('a.ts'), '[write_file: a.ts] Denied by user'), { succeeded: false });
  assert.deepEqual(toolOutcome(run('npm test'), '[run_terminal: npm test]\nExit: 1\nfailed'), { succeeded: true, exitCode: 1 });
  assert.deepEqual(toolOutcome(run('npm test'), '[run_terminal] Denied by user:\nnpm test'), { succeeded: false });
});

test('a "before" hook that fails refuses the edit, with its reason; one that passes lets it through', async () => {
  const guard = script('guard.js', `const input = JSON.parse(require('fs').readFileSync(process.env.CODICO_HOOK_INPUT, 'utf8'));
if (/DROP TABLE/.test(input.content || '')) { console.log('Migrations may not drop tables: ' + process.env.CODICO_HOOK_FILE); process.exit(3); }`);
  const hooks = project([{ event: 'beforeEdit', match: 'migrations/**', name: 'migration rules', command: guard }]);
  const refused = await hooks.before(write('migrations/002.sql', 'DROP TABLE users;'), noAbort);
  assert.match(refused, /^\[write_file\] Refused by the project's beforeEdit hook "migration rules": it exited with code 3, so migrations\/002\.sql was not changed\.\nThe hook said:\nMigrations may not drop tables: migrations\/002\.sql\n/);
  assert.match(refused, /This is a rule of the project, not an error to retry/);
  assert.equal(await hooks.before(write('migrations/003.sql', 'ALTER TABLE users ADD email text;'), noAbort), '');
  assert.equal(await hooks.before(write('src/a.sql', 'DROP TABLE users;'), noAbort), '', 'not a file the hook is for');
  assert.equal(await hooks.before({ type: 'read_file', filepath: 'migrations/002.sql' }, noAbort), '');
  // The input file is removed afterwards
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('codico-hook-')), []);
});

test('an "after" hook adds what it printed to the result; silence adds nothing', async () => {
  const lint = script('lint.js', `const file = process.argv[2]; if (file.endsWith('bad.ts')) { console.log(file + ':3 unused variable'); process.exit(1); }`);
  const hooks = project([{ event: 'afterEdit', match: '**/*.ts', name: 'lint', command: `${lint} {file}` }]);
  const applied = (file) => `[edit_file: ${file}] Edit applied successfully.`;
  assert.equal(await hooks.after(edit('src/bad.ts'), applied('src/bad.ts'), noAbort), '\n\n[Project afterEdit hook "lint" failed (exit 1)]\nsrc/bad.ts:3 unused variable');
  assert.equal(await hooks.after(edit('src/good.ts'), applied('src/good.ts'), noAbort), '');
  // The edit did not happen: there is nothing to check
  assert.equal(await hooks.after(edit('src/bad.ts'), '[edit_file: src/bad.ts] ERROR: old_str not found', noAbort), '');
  assert.equal(reportText({ event: 'afterEdit', command: 'fmt', timeoutSeconds: 30 }, { exitCode: 0, timedOut: false, output: 'formatted 1 file' }), '\n\n[Project afterEdit hook "fmt" passed]\nformatted 1 file');
});

test('command hooks: a command can be refused, and a finished one is passed its exit code', async () => {
  const report = script('after.js', `console.log('exit was ' + process.env.CODICO_HOOK_EXIT_CODE + ' for ' + process.env.CODICO_HOOK_COMMAND);`);
  const hooks = project([{ event: 'beforeCommand', match: 'git push*', name: 'no pushing', command: 'node -e "process.exit(1)"' }, { event: 'afterCommand', match: 'npm test*', command: report }]);
  assert.match(await hooks.before(run('git push origin main'), noAbort), /^\[run_terminal\] Refused by the project's beforeCommand hook "no pushing": it exited with code 1, so the command was not run\./);
  assert.equal(await hooks.before(run('git status'), noAbort), '');
  assert.match(await hooks.after(run('npm test'), '[run_terminal: npm test]\nExit: 2\n1 failing', noAbort), /hook "node after\.js" passed\]\nexit was 2 for npm test$/);
  assert.equal(await hooks.after(run('npm test'), '[run_terminal] Denied by user:\nnpm test', noAbort), '');
});

test('a hook that hangs is stopped; as a "before" hook it refuses, since the check did not pass', async () => {
  const hooks = project([{ event: 'beforeEdit', name: 'slow check', command: 'node -e "setTimeout(() => {}, 60000)"', timeoutSeconds: 1 }]);
  const started = Date.now();
  const refused = await hooks.before(edit('src/a.ts'), noAbort);
  assert.ok(Date.now() - started < 15000);
  assert.match(refused, /Refused by the project's beforeEdit hook "slow check": it did not finish within 1 seconds/);
  assert.match(refusalText(run('x'), { event: 'beforeCommand', command: 'c', timeoutSeconds: 5 }, { exitCode: 1, timedOut: false, output: '' }), /it exited with code 1, so the command was not run\.\nThis is a rule/);
});

test('a hook runs only after the user has allowed that exact command, once per workspace', async () => {
  const ok = script('ok.js', `process.exit(0);`);
  const hooks = project([{ event: 'beforeEdit', name: 'check', command: `${ok} {file}`, match: '*.ts' }]);
  answer = undefined; // the dialog is dismissed
  assert.equal(await hooks.before(edit('a.ts'), noAbort), '', 'not allowed: the hook does not run, and the edit is not held up');
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /This project wants Codico to run a command as a beforeEdit hook\./);
  assert.match(dialogs[0].detail, /check\n\nCommand:\n    node ok\.js \{file\}\n\nFor: \*\.ts\n\n/);
  assert.match(dialogs[0].detail, /\.codico\/hooks\.json in this project/);
  await hooks.before(edit('b.ts'), noAbort);
  assert.equal(dialogs.length, 1, 'not asked again on every tool call');
  // A new session asks again; allowing is remembered for the workspace
  const again = new HookRunner(() => memento);
  answer = 'Allow for This Workspace';
  await again.before(edit('a.ts'), noAbort);
  assert.equal(dialogs.length, 2);
  assert.equal(Object.keys(state.get(APPROVED_HOOKS_KEY)).length, 1);
  await new HookRunner(() => memento).before(edit('a.ts'), noAbort);
  assert.equal(dialogs.length, 2);
  // The file now names another command: that is asked about
  fs.writeFileSync(path.join(root, '.codico', 'hooks.json'), JSON.stringify({ hooks: [{ event: 'beforeEdit', command: 'node -e "process.exit(0)"' }] }));
  answer = undefined;
  await new HookRunner(() => memento).before(edit('a.ts'), noAbort);
  assert.equal(dialogs.length, 3);
  assert.match(dialogs[2].detail, /node -e "process\.exit\(0\)"/);
});

test('no hooks in an untrusted folder, for a path the file tools refuse, or without a hooks file', async () => {
  const hooks = project([{ event: 'beforeEdit', command: 'node -e "process.exit(1)"' }]);
  trusted = false;
  assert.equal(await hooks.before(edit('a.ts'), noAbort), '');
  assert.equal(dialogs.length, 0);
  trusted = true;
  assert.equal(await hooks.before(edit('../outside.ts'), noAbort), '', 'the tool itself rejects the path');
  assert.equal(dialogs.length, 0);
  fs.rmSync(path.join(root, '.codico', 'hooks.json'));
  assert.equal(await new HookRunner(() => memento).before(edit('a.ts'), noAbort), '');
});

test('a hooks file with mistakes still runs its valid hooks, and the mistakes are reported once', async () => {
  const hooks = project(JSON.stringify({ hooks: [{ event: 'whenever', command: 'x' }, { event: 'beforeCommand', match: 'deploy*', command: 'node -e "process.exit(1)"' }] }));
  assert.match(await hooks.before(run('deploy prod'), noAbort), /Refused by the project's beforeCommand hook/);
  await hooks.before(run('deploy staging'), noAbort);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\.codico\/hooks\.json has a problem, so part of it is not used: hooks\[0\]: "event" must be one of/);
});

test('automated runs have nobody to ask: hooks run without the dialog there', async () => {
  project([{ event: 'beforeCommand', command: 'node -e "process.exit(1)"' }]);
  const hooks = new HookRunner(() => memento, () => true);
  assert.match(await hooks.before(run('anything'), noAbort), /Refused/);
  assert.equal(dialogs.length, 0);
});

test('New Hooks File writes a valid starting file and does not overwrite an existing one', async () => {
  fs.rmSync(path.join(root, '.codico'), { recursive: true, force: true });
  await createHooksFile();
  const file = path.join(root, '.codico', 'hooks.json');
  assert.equal(fs.readFileSync(file, 'utf8'), HOOKS_TEMPLATE);
  fs.writeFileSync(file, '{"hooks":[]}');
  await createHooksFile();
  assert.equal(fs.readFileSync(file, 'utf8'), '{"hooks":[]}');
});
