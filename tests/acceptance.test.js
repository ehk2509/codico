const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { AcceptanceRecorder, parseReview, reviewPrompt, acceptanceMarkdown, criterionLine } = require('../out/acceptance.js');
const { PassportRecorder, passportMarkdown } = require('../out/patchPassport.js');
const { parseVerifyFence, verifyToolFromArgs } = require('../out/verifyTools.js');
const { parseToolCalls } = require('../out/toolParser.js');
const { nativeToolCallToToolCall, getNativeToolDefinitions } = require('../out/nativeTools.js');
const { animatedPng, readPng } = require('../out/apng.js');
const { EvidenceStore } = require('../out/evidenceStore.js');
const { AppRunner, localAppUrl, probe } = require('../out/appRunner.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-acceptance-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('a criterion is verified only by evidence Codico observed after the last change', () => {
  const p = new PassportRecorder();
  const a = p.acceptance;
  a.setCriteria(['Saving shows "Saved"', 'An empty name is refused', 'The list keeps its order']);
  // Before the fix: the bug is shown (a failing assertion), and recorded as such
  const before = a.addEvidence({ kind: 'expect', description: '.toast shows "Saved"', passed: false, detail: 'no element matches the selector' });
  assert.match(a.claim('AC1', 'fail', 'clicked Save; no toast', [before]).text, /AC1 recorded as not met on E1/);
  p.recordChange('src/save.ts', 'old', 'new');
  // After: an assertion passes for AC1; a test run is named for AC2; AC3 is only claimed
  const after = a.addEvidence({ kind: 'expect', description: '.toast shows "Saved"', passed: true, detail: 'the element shows "Saved"' });
  a.claim('AC1', 'pass', 'clicked Save', [after]);
  const testRun = p.recordCommand('npm test', 0, '# pass 12\n# fail 0\n');
  assert.equal(testRun, 'E3');
  a.claim('ac2', 'pass', 'unit test for the empty name', ['e3']);
  a.claim('AC3', 'pass', 'looked at it', []);
  const report = p.build().acceptance;
  assert.deepEqual(report.criteria.map(c => [c.id, c.status, c.reproduced]), [['AC1', 'verified', true], ['AC2', 'verified', false], ['AC3', 'claimed', false]]);
  assert.equal(report.verdict, 'partial');
  // A change after the evidence makes it stale
  p.recordChange('src/save.ts', 'new', 'newer');
  assert.deepEqual(p.build().acceptance.criteria.map(c => c.status), ['stale', 'stale', 'claimed']);
});

test('failing evidence after the change fails the criterion; a reviewer who disputes it keeps it from being accepted', () => {
  const p = new PassportRecorder();
  const a = p.acceptance;
  a.setCriteria(['Totals update']);
  p.recordChange('a.js', '', 'x');
  const bad = a.addEvidence({ kind: 'expect', description: 'total shows 42', passed: false, detail: 'shows 40' });
  a.claim('AC1', 'pass', 'it works', [bad]);
  assert.equal(p.build().acceptance.verdict, 'failing');
  const good = a.addEvidence({ kind: 'expect', description: 'total shows 42', passed: true, detail: 'shows 42' });
  a.claim('AC1', 'pass', 'it works', [good]);
  assert.equal(p.build().acceptance.verdict, 'accepted');
  a.setReview('AC1', { agrees: false, reason: 'the assertion checks the label, not the total' });
  const report = p.build();
  assert.equal(report.acceptance.verdict, 'disputed');
  assert.match(report.notes[0], /Not accepted: the reviewer disputes the evidence \(AC1\)/);
});

test('claims are refused for unknown criteria and unknown evidence; stating the criteria again keeps what was checked', () => {
  const a = new AcceptanceRecorder((() => { let n = 0; return () => ++n; })());
  assert.match(a.claim('AC1', 'pass', '', []).text, /state the acceptance criteria first/);
  a.setCriteria(['One', 'Two']);
  assert.match(a.claim('AC9', 'pass', '', []).text, /no criterion "AC9"\. The criteria are AC1, AC2/);
  assert.match(a.claim('AC1', 'pass', '', ['E7']).text, /no evidence E7/);
  const e = a.addEvidence({ kind: 'check', description: 'test', passed: true, detail: 'exit 0' });
  a.claim('AC2', 'pass', '', [e]);
  a.setCriteria(['Zero', 'Two', 'Three']);
  const report = a.build(0);
  assert.deepEqual(report.criteria.map(c => [c.id, c.text, c.status]), [['AC1', 'Zero', 'open'], ['AC2', 'Two', 'verified'], ['AC3', 'Three', 'open']]);
  assert.match(a.setCriteria(['  ']), /ERROR/);
});

test('without criteria, passing checks are reported as checks, and the report says the request itself was not shown', () => {
  const p = new PassportRecorder();
  p.recordChange('a.js', '', 'x');
  p.recordCommand('npm run build', 0, '');
  const report = p.build();
  assert.equal(report.verdict, 'verified');
  assert.equal(report.acceptance, undefined);
  assert.ok(report.notes.some(n => /No acceptance criteria were stated: passing checks do not show that the request itself is met/.test(n)));
  assert.match(passportMarkdown(report), /\*\*Checks pass after the last change\*\* · acceptance not stated/);
  // A turn that only verified, without changing anything, still has a report
  const v = new PassportRecorder();
  v.acceptance.setCriteria(['The page loads']);
  assert.ok(v.build());
});

test('the reviewer sees the criteria and the observed evidence, and its answer is read per criterion', () => {
  const p = new PassportRecorder();
  p.acceptance.setCriteria(['Saving shows "Saved"']);
  const e = p.acceptance.addEvidence({ kind: 'expect', description: '.toast shows "Saved"', passed: true, detail: 'shows "Saved"', url: 'http://localhost:5173/', consoleErrors: ['console: boom'] });
  p.acceptance.browserStep({ action: 'click', target: 'button.save', url: 'http://localhost:5173/', text: 'Saved Profile' });
  p.acceptance.claim('AC1', 'pass', 'clicked Save', [e]);
  const prompt = reviewPrompt(p.build().acceptance, p.acceptance.steps, 'src/a.ts +3 -1');
  assert.match(prompt, /AC1: Saving shows "Saved"[\s\S]*E1 PASSED \[expect\] \.toast shows "Saved"[\s\S]*console errors on the page: console: boom/);
  assert.match(prompt, /click button\.save → http:\/\/localhost:5173\/\n  page text: Saved Profile/);
  assert.match(prompt, /src\/a\.ts \+3 -1/);
  const review = parseReview('AC1: no — the toast is checked, not the saved data\n**AC2**: yes - fine\nnoise');
  assert.deepEqual(review.get('AC1'), { agrees: false, reason: 'the toast is checked, not the saved data' });
  assert.equal(review.get('AC2').agrees, true);
});

test('the report in Markdown: verdict, criteria with their evidence and screenshots, console errors, evidence folder', () => {
  const p = new PassportRecorder();
  p.acceptance.setCriteria(['It works']);
  p.recordChange('a.js', '', 'x');
  const e = p.acceptance.addEvidence({ kind: 'expect', description: 'page shows "ok"', passed: true, detail: 'the page shows the text', screenshot: '.codico/evidence/x/02-expect.png' });
  p.acceptance.consoleError('console: TypeError: x is undefined');
  p.acceptance.claim('AC1', 'pass', 'opened it', [e]);
  p.acceptance.evidenceFolder = '.codico/evidence/x';
  const md = passportMarkdown(p.build());
  assert.match(md, /\*\*Accepted: every criterion verified on the final code\*\* · No check passed after the last change/);
  assert.match(md, /### Acceptance — Accepted[\s\S]*- ✅ \*\*AC1\*\* It works — verified\n  - E1 passed: page shows "ok" \(the page shows the text\) \[screenshot\]\(\.codico\/evidence\/x\/02-expect\.png\)/);
  assert.match(md, /Console errors after the last change \(1\):\n- `console: TypeError: x is undefined`/);
  assert.match(md, /Evidence \(screenshots, replay, report\): `\.codico\/evidence\/x`/);
  assert.match(criterionLine(p.build().acceptance.criteria[0]), /^AC1 \[verified\] It works — E1 passed/);
});

test('the verification tools in both formats', () => {
  assert.deepEqual(parseVerifyFence('app', 'action: start\ncommand: npm run dev -- --port 5173\nurl: http://localhost:5173'), { type: 'app', action: 'start', command: 'npm run dev -- --port 5173', url: 'http://localhost:5173' });
  assert.equal(parseVerifyFence('app', 'action: start\ncommand: npm run dev'), null, 'a start needs the address');
  assert.deepEqual(parseVerifyFence('browser_expect', 'selector: .toast\ntext: "Saved  "\ntimeout_ms: 8000'), { type: 'browser_expect', selector: '.toast', text: 'Saved  ', timeoutMs: 8000 });
  assert.deepEqual(parseVerifyFence('acceptance', 'action: criteria\ncriteria:\n- First thing\n2. Second thing\nAC3: Third'), { type: 'acceptance', action: 'criteria', criteria: ['First thing', 'Second thing', 'Third'] });
  assert.deepEqual(parseVerifyFence('acceptance', 'action: verify\ncriterion: AC1\nresult: pass\nevidence: E3, E4\nhow: clicked it\nand it showed'), { type: 'acceptance', action: 'verify', criterion: 'AC1', result: 'pass', evidence: ['E3', 'E4'], how: 'clicked it\nand it showed' });
  assert.deepEqual(nativeToolCallToToolCall({ name: 'acceptance', arguments: { action: 'verify', criterion: 'AC2', result: 'fail', evidence: ['E1'] } }), { type: 'acceptance', action: 'verify', criterion: 'AC2', result: 'fail', evidence: ['E1'], how: '' });
  assert.equal(verifyToolFromArgs('browser_expect', {}), null);
  const fenced = parseToolCalls('Checking.\n```browser_expect\ntext: Welcome\n```\n');
  assert.deepEqual(fenced, [{ type: 'browser_expect', text: 'Welcome' }]);
  const names = getNativeToolDefinitions().map(t => t.name);
  assert.ok(['app', 'browser_expect', 'acceptance'].every(n => names.includes(n)));
});

/** A small PNG of one color, as Chrome writes them. */
function png(width, height, rgb) {
  const crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } crcTable[n] = c >>> 0; }
  const crc = buf => { let c = 0xffffffff; for (const b of buf) { c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32BE(data.length); h.write(type, 4); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([h.subarray(4), data]))); return Buffer.concat([h, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) { for (let x = 0; x < width; x++) { raw.set(rgb, y * (width * 3 + 1) + 1 + x * 3); } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('the replay is an animated PNG of the screenshots, frames of another size left out', () => {
  const frames = [png(4, 3, [255, 0, 0]), png(4, 3, [0, 255, 0]), png(5, 3, [0, 0, 255]), png(4, 3, [0, 0, 255])];
  const out = animatedPng(frames, 500);
  const types = []; for (let o = 8; o < out.length;) { const len = out.readUInt32BE(o); types.push(out.toString('ascii', o + 4, o + 8)); o += 12 + len; }
  assert.deepEqual(types, ['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'fcTL', 'fdAT', 'IEND']);
  assert.equal(out.readUInt32BE(8 + 8 + 13 + 4 + 8), 3, 'acTL says 3 frames');
  // The first frame is a normal PNG image: a viewer without animation shows it
  const first = readPng(out);
  assert.equal(first.width, 4); assert.equal(first.idat.length, 1);
  assert.deepEqual(zlib.inflateSync(first.idat[0]).subarray(1, 4), Buffer.from([255, 0, 0]));
  assert.equal(animatedPng([Buffer.from('not a png')]), undefined);
});

test('evidence is saved in .codico/evidence, ignored by git, with the report and the replay', () => {
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const store = new EvidenceStore(project, 'run1');
  assert.equal(store.folder, undefined, 'nothing is made before something is saved');
  assert.equal(store.screenshot(png(2, 2, [1, 2, 3]), 'navigate http://localhost:5173/'), '.codico/evidence/run1/01-navigate-http-localhost-5173.png');
  store.screenshot(png(2, 2, [9, 9, 9]), 'expect .toast shows "Saved"');
  store.finish('# report\n');
  const dir = path.join(project, '.codico', 'evidence');
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*\n');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'run1')).sort(), ['01-navigate-http-localhost-5173.png', '02-expect-toast-shows-saved.png', 'replay.png', 'report.md']);
  assert.equal(new EvidenceStore(undefined).screenshot(png(1, 1, [0, 0, 0]), 'x'), undefined, 'no project folder: nothing saved');
});

test('an app is started in the background, reached when its address answers, and stopped with what it started', { skip: process.platform === 'win32' && 'shell quoting differs' }, async () => {
  assert.equal(localAppUrl('https://example.com'), undefined);
  assert.equal(localAppUrl('http://localhost:5173/app').origin, 'http://localhost:5173');
  const port = 43000 + Math.floor(Math.random() * 1000);
  const server = path.join(root, 'server.js');
  fs.writeFileSync(server, `setTimeout(() => require('http').createServer((q, s) => s.end('hello')).listen(${port}, '127.0.0.1', () => console.log('listening on ${port}')), 300);`);
  const runner = new AppRunner();
  const signal = new AbortController().signal;
  const started = await runner.start({ command: `node ${JSON.stringify(server)}`, url: `http://127.0.0.1:${port}/`, cwd: root, timeoutMs: 15000, signal });
  assert.equal(started.ok, true, started.text);
  assert.match(started.text, /answers[\s\S]*listening on/);
  assert.deepEqual(runner.origins, [`http://127.0.0.1:${port}`]);
  assert.match((await runner.start({ command: `node ${JSON.stringify(server)}`, url: `http://127.0.0.1:${port}/`, cwd: root, timeoutMs: 1000, signal })).text, /Already running/);
  assert.match(runner.logs(), /running\): node[\s\S]*listening on/);
  assert.equal(runner.stop(), 1);
  for (let i = 0; i < 40 && await probe(new URL(`http://127.0.0.1:${port}/`), 200); i++) { await new Promise(r => setTimeout(r, 100)); }
  assert.equal(await probe(new URL(`http://127.0.0.1:${port}/`), 200), false, 'the server is gone');
  // A command that ends without serving, and one that never answers
  const failed = await runner.start({ command: 'node -e "console.log(\'bad config\'); process.exit(3)"', url: `http://127.0.0.1:${port + 1}/`, cwd: root, timeoutMs: 10000, signal });
  assert.match(failed.text, /ended \(exit 3\)[\s\S]*bad config/);
  const silent = await runner.start({ command: 'node -e "setTimeout(() => {}, 60000)"', url: `http://127.0.0.1:${port + 2}/`, cwd: root, timeoutMs: 1200, signal });
  assert.match(silent.text, /nothing answered .* within 1 s; the command was stopped/);
  assert.match((await runner.start({ command: 'x', url: 'https://example.com', cwd: root, timeoutMs: 1000, signal })).text, /not an address on this machine/);
});

test('a failed run that a later run of the same check passed does not fail the criterion (old code restored with git stash to reproduce)', () => {
  const p = new PassportRecorder();
  const a = p.acceptance;
  p.recordChange('src/toolParser.ts', 'old', 'fixed');
  a.setCriteria(['A normal write_file call keeps inner code fences']);
  // The fix stashed in the terminal (Codico sees no file change), the tests run on the old code, then the fix restored
  const onOldCode = p.recordCommand('npm run compile 2>&1 | tail -5 && node --test tests/toolParser.test.js 2>&1', 1, '# pass 4\n# fail 3\n');
  const onFix = p.recordCommand('npm run compile 2>&1 | tail -5 && node --test tests/toolParser.test.js 2>&1', 0, '# pass 7\n# fail 0\n');
  a.claim('AC1', 'pass', 'failed on the old code, passes with the fix', [onOldCode, onFix]);
  assert.equal(p.build().acceptance.criteria[0].status, 'verified');
  // A failure that nothing later passed still fails it
  const p2 = new PassportRecorder();
  p2.recordChange('src/a.ts', 'x', 'y');
  p2.acceptance.setCriteria(['works']);
  const failed = p2.recordCommand('node --test tests/a.test.js', 1, '# pass 1\n# fail 1\n');
  p2.acceptance.claim('AC1', 'pass', 'ran it', [failed]);
  assert.equal(p2.build().acceptance.criteria[0].status, 'failing');
});

test('the reviewer reads the tests the agent wrote, and is told a loose or different-case assertion does not show a criterion', () => {
  const p = new PassportRecorder();
  p.recordChange('src/toolParser.ts', 'a', 'b');
  p.acceptance.setCriteria(['write_file keeps the exact content, inner code fences included']);
  const run = p.recordCommand('node --test tests/fences.test.js', 0, '# pass 7\n# fail 0\n');
  p.acceptance.claim('AC1', 'pass', 'test of a README with a bash block', [run]);
  const report = p.build().acceptance;
  const prompt = reviewPrompt(report, [], 'src/toolParser.ts +10 -2', [{ path: 'tests/fences.test.js', text: "assert.match(tools[0].content, /cd server/);" }]);
  assert.match(prompt, /Tests the agent wrote or changed:\n--- tests\/fences\.test\.js\nassert\.match\(tools\[0\]\.content, \/cd server\/\);/);
  assert.match(prompt, /compares loosely \(a substring, a trimmed or partial value\) where the criterion needs an exact result/);
  // Without tests the prompt is as before
  assert.doesNotMatch(reviewPrompt(report, [], ''), /Tests the agent wrote/);
});

test('a check whose result cannot be told (hidden by a pipe) is no evidence: it neither fails nor verifies a criterion', () => {
  const p = new PassportRecorder();
  p.recordChange('src/a.ts', 'x', 'y');
  p.acceptance.setCriteria(['works', 'builds']);
  const hidden = p.recordCommand('npx tsc -p ./ 2>&1 | head -20', 0, '');
  const tests = p.recordCommand('npm test', 0, '# pass 8\n# fail 0\n');
  p.acceptance.claim('AC1', 'pass', 'compiled and tested', [hidden, tests]);
  p.acceptance.claim('AC2', 'pass', 'compiled', [hidden]);
  assert.deepEqual(p.build().acceptance.criteria.map(c => c.status), ['verified', 'claimed']);
});

test('the reviewer is given the user\'s request and judges whether the criteria and tests cover it as asked; a "no" disputes the acceptance', () => {
  const { verdictNote } = require('../out/acceptance.js');
  const p = new PassportRecorder();
  p.recordChange('src/toolParser.ts', 'a', 'b');
  p.acceptance.setCriteria(['A 4-backtick write_file keeps inner fences']);
  const run = p.recordCommand('npm test', 0, '# pass 9\n# fail 0\n');
  p.acceptance.claim('AC1', 'pass', 'tests 8 and 9', [run]);
  const request = 'Allow write_file content to contain Markdown code fences without truncating or corrupting the outer tool call.';
  const prompt = reviewPrompt(p.build().acceptance, [], 'src/toolParser.ts +40 -3', [], request);
  assert.match(prompt, /The user's request, which the change must meet as asked:\nAllow write_file content to contain Markdown code fences/);
  assert.match(prompt, /REQUEST: yes — <why> \(or no — <what is not covered>\)/);
  assert.match(prompt, /not a different mechanism \(a new syntax, option or mode\) or a narrower case/);
  // Without a request the prompt asks nothing about it
  assert.doesNotMatch(reviewPrompt(p.build().acceptance, [], ''), /REQUEST:/);

  for (const [id, review] of parseReview('AC1: yes — tests 8 and 9 pass\nREQUEST: no — only the four-backtick form is tested; the normal write_file call still truncates')) { p.acceptance.setReview(id, review); }
  const report = p.build().acceptance;
  assert.equal(report.verdict, 'disputed', 'every criterion verified, but not the request');
  assert.match(report.requestReview.reason, /only the four-backtick form/);
  const note = verdictNote(report);
  assert.match(note, /^\n\n> \*\*Codico's check: Not accepted: the reviewer disputes the evidence\.\*\* the request as asked, disputed by the reviewer: only the four-backtick form/);
  assert.match(note, /Whatever the reply above says, this is not verified as done\.$/);
  assert.match(passportMarkdown(p.build()), /❌ \*\*The request as asked\*\* — reviewer disputes: only the four-backtick form/);
  // Accepted: no note
  p.acceptance.setReview('REQUEST', { agrees: true, reason: 'the normal form is tested' });
  assert.equal(verdictNote(p.build().acceptance), undefined);
});

test('criteria are given as text, one per line: a list of free-text items is where models wrote invalid JSON', () => {
  const { getNativeToolDefinitions, nativeToolCallToToolCall } = require('../out/nativeTools.js');
  const schema = getNativeToolDefinitions(false).find(t => t.name === 'acceptance').inputSchema.properties.criteria;
  assert.equal(schema.type, 'string');
  assert.deepEqual(nativeToolCallToToolCall({ name: 'acceptance', arguments: { action: 'criteria', criteria: '- A waiting task shows "needs you"\n2. A running task does not\n\n' } }),
    { type: 'acceptance', action: 'criteria', criteria: ['A waiting task shows "needs you"', 'A running task does not'] });
  // A list still works, from models that send one
  assert.deepEqual(nativeToolCallToToolCall({ name: 'acceptance', arguments: { action: 'criteria', criteria: ['One', 'Two'] } }).criteria, ['One', 'Two']);
});

test('the reviewer is shown the part of a test file the turn changed, not its start', () => {
  const { changedPart } = require('../out/acceptance.js');
  // Seen in the holdout: new tests appended to a long test file were cut off, and the reviewer could not see them
  const old = Array.from({ length: 800 }, (_, i) => `test('existing ${i}', () => { assert.ok(true); });`).join('\n') + '\n';
  const added = "test('names: fenced and native forms', () => {\n  assert.equal(parseTeamFence('action: start\\nname: Front End!').name, 'front-end');\n});\n";
  const part = changedPart(old, old + added);
  assert.match(part, /^\(lines 7\d\d–80\d of 80\d: the part this turn changed; the rest of the file is unchanged\)/);
  assert.match(part, /names: fenced and native forms/);
  assert.match(part, /\n80\d\t  assert/);
  assert.doesNotMatch(part, /existing 0'/);
  // A change in the middle: that region, with its context
  const lines = old.split('\n'); lines[200] = "test('existing 200', () => { assert.equal(f(), 2); });";
  const middle = changedPart(old, lines.join('\n'));
  assert.match(middle, /assert\.equal\(f\(\), 2\)/);
  assert.match(middle, /^\(lines 181–221 of /);
  // A new file, or a short one: whole
  assert.equal(changedPart(null, added), added);
  assert.equal(changedPart('a\n', added), added);
  assert.match(changedPart(undefined, 'x'.repeat(21000)), /… \(cut\)$/);
  assert.equal(changedPart(undefined, 'x'.repeat(9000)), 'x'.repeat(9000), 'up to 20,000 characters are shown');
});

test('the reviewer asks for the request\'s own example, given to the code the user calls', () => {
  const { reviewPrompt, AcceptanceRecorder } = require('../out/acceptance.js');
  const r = new AcceptanceRecorder(() => 1);
  r.setCriteria(['A worker named "Backend API" shows as backend-api']);
  const prompt = reviewPrompt(r.build(0), [], 'src/teamTools.ts +5', [], 'The start action takes a name ("Backend API"): `Started worker backend-api (1a2b3c4d)`.');
  assert.match(prompt, /Where the request gives an example \(an input and what it must produce\), a test must give that very input to the code the user calls \(the tool, command or public function, not a helper behind it\)/);
  assert.match(prompt, /a test of the helper alone, or with an input already in its final form, does not cover it/);
  assert.match(prompt, /a test that expects the unconverted value on that path contradicts the request/);
  // Without a request there is no request line at all
  assert.doesNotMatch(reviewPrompt(r.build(0), [], '', [], ''), /Where the request gives an example/);
});

test('evidence ids are given as text too: lists of strings are where models wrote invalid JSON', () => {
  const { getNativeToolDefinitions, nativeToolCallToToolCall } = require('../out/nativeTools.js');
  assert.equal(getNativeToolDefinitions(false).find(t => t.name === 'acceptance').inputSchema.properties.evidence.type, 'string');
  assert.deepEqual(nativeToolCallToToolCall({ name: 'acceptance', arguments: { action: 'verify', criterion: 'AC1', result: 'pass', evidence: 'E1 E3' } }).evidence, ['E1', 'E3']);
  assert.deepEqual(nativeToolCallToToolCall({ name: 'acceptance', arguments: { action: 'verify', criterion: 'AC1', result: 'pass', evidence: ['E2'] } }).evidence, ['E2']);
});

test('small JSON slips in a complete tool call are repaired; a partial call is left to finish', () => {
  const { parseArguments, OpenAIToolCallAccumulator } = require('../out/nativeTools.js');
  // Seen from Claude Sonnet: a stray comma on its own line
  assert.deepEqual(parseArguments('{"filepath": "tests/a.test.js", "start_line": 121, \n, "end_line": 130}'), { filepath: 'tests/a.test.js', start_line: 121, end_line: 130 });
  assert.deepEqual(parseArguments('{"a": [1, 2,], }'), { a: [1, 2] });
  assert.throws(() => parseArguments('{"criteria": unquoted text}'));
  assert.throws(() => parseArguments('{"a": 1,', false), 'still streaming: not repaired');
  const acc = new OpenAIToolCallAccumulator();
  acc.add({ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"filepath": "a.ts", , "start_line": 3}' } });
  assert.deepEqual(acc.flushReady(), [], 'not repaired before the stream ends');
  assert.deepEqual(acc.flushReady(true), [{ id: 'c1', name: 'read_file', arguments: { filepath: 'a.ts', start_line: 3 } }]);
});
