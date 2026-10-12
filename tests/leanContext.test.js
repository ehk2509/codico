const test = require('node:test');
const assert = require('node:assert/strict');
const { isNoiseFile, openTabsBlock, MAX_OPEN_TABS, renderSearchMatches, SEARCH_MAX_SHOWN, SEARCH_MAX_PER_FILE, ReminderLog, REMINDER_FULL_EVERY } = require('../out/leanContext.js');

test('open tabs are named, not sent, and lock files and generated output are not even named', () => {
  for (const noise of ['package-lock.json', 'web/yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum', 'dist/extension.js', 'out/a.js', 'node_modules/x/index.js', 'public/app.min.js', 'dist\\win\\a.js', 'a.js.map', '.gitignore']) {
    assert.equal(isNoiseFile(noise), true, noise);
  }
  for (const real of ['src/app.ts', 'package.json', 'README.md', 'tests/lock.test.js', 'src/output/render.ts', 'docs/build.md', 'src/distance.ts']) { assert.equal(isNoiseFile(real), false, real); }
  const block = openTabsBlock([{ path: 'package-lock.json', language: 'json', lines: 9000 }, { path: 'src/app.ts', language: 'typescript', lines: 120 }, { path: 'README.md' }]);
  assert.equal(block, 'Other open tabs (names only; read a file if it matters): src/app.ts (typescript, 120 lines), README.md');
  assert.equal(openTabsBlock([{ path: 'yarn.lock' }]), '');
  assert.equal(openTabsBlock([]), '');
  const many = openTabsBlock(Array.from({ length: 30 }, (_, i) => ({ path: `src/f${i}.ts` })));
  assert.equal(many.split(', ').length, MAX_OPEN_TABS);
  assert.ok(many.length < 200);
});

test('a small search result is returned as it is', () => {
  const matches = ['src/a.ts:3:const retry = 1;', 'src/b.ts:10:retry();'];
  assert.equal(renderSearchMatches(matches, true), matches.join('\n'));
  assert.equal(renderSearchMatches([], true), '');
});

test('a large search result shows the first matches, a few per file, and says exactly what was left out', () => {
  const matches = [];
  for (let i = 1; i <= 30; i++) { matches.push(`README.md:${i}:duplicate word in the docs ${i}`); }
  for (let i = 1; i <= 4; i++) { matches.push(`src/threads.ts:${i * 10}:function duplicate${i}() {}`); }
  for (let f = 0; f < 20; f++) { for (let i = 1; i <= 8; i++) { matches.push(`tests/t${f}.test.js:${i}:duplicate ${i}`); } }
  const out = renderSearchMatches(matches, true);
  const lines = out.split('\n');
  const shown = lines.slice(0, -1);
  assert.equal(shown.length, SEARCH_MAX_SHOWN);
  // One file with many matches does not crowd out the others
  assert.equal(shown.filter(l => l.startsWith('README.md:')).length, SEARCH_MAX_PER_FILE);
  assert.equal(shown.filter(l => l.startsWith('src/threads.ts:')).length, 4);
  assert.match(lines.at(-1), /^… showing 40 of 194 matches in 22 files\. Not shown: README\.md \(24\), /);
  assert.match(lines.at(-1), /and \d+ more files\. Narrow the search with a longer pattern or a glob for one folder or file to see the rest\.$/);
  // The numbers add up: shown plus every "not shown" count is the total
  assert.ok(out.length < 3500, `${out.length} characters`);
  // A very long matching line is cut; the path and line number never are
  const long = renderSearchMatches(['src/a.ts:7:' + 'x'.repeat(900)], true);
  assert.equal(long, 'src/a.ts:7:' + 'x'.repeat(200) + '…');
  // The scan stopped early: the count is a lower bound and says so
  assert.match(renderSearchMatches(matches, false), /showing 40 of 194\+ matches/);
  assert.match(renderSearchMatches(['a.ts:1:x'], false), /^a\.ts:1:x\n… showing 1 of 1\+ matches in 1 file\. Narrow the search/);
  // A Windows-style drive in the text, or a colon in the matched line, is not mistaken for the path
  assert.equal(renderSearchMatches(['src/a.ts:3:const url = "http://x:80";'], true), 'src/a.ts:3:const url = "http://x:80";');
});

test('a reminder is given in full once, then as one short line while it still applies', () => {
  const log = new ReminderLog();
  const unwired = '[System Integration] A helper import is still unwired. Inspect only the caller/dependency evidence needed to wire it, then edit and verify. Do not finish while the import remains unused.';
  const verify = '[System Verification] Verification failed. Use the failure as evidence, revise the implementation, and verify again.';
  assert.equal(log.say(unwired), unwired);
  assert.equal(log.say(unwired), '[System Integration] Still applies (see above).');
  // Another reminder is independent of the first
  assert.equal(log.say(verify), verify);
  assert.equal(log.say(verify), '[System Verification] Still applies (see above).');
  // Repeated often enough, the full text returns once: its first copy may have been compacted away
  const said = [unwired, 'short'];
  for (let i = 2; i < REMINDER_FULL_EVERY * 2 + 1; i++) { said.push(log.say(unwired) === unwired ? unwired : 'short'); }
  assert.deepEqual(said.map((s, i) => s === unwired ? i : -1).filter(i => i >= 0), [0, REMINDER_FULL_EVERY, REMINDER_FULL_EVERY * 2]);
  // 14 repeats of one note, as in the recorded task: a fraction of the text
  const fresh = new ReminderLog(); let chars = 0;
  for (let i = 0; i < 14; i++) { chars += fresh.say(unwired).length; }
  assert.ok(chars < unwired.length * 14 * 0.5, `${chars} of ${unwired.length * 14}`);
  assert.equal(new ReminderLog().say('no tag here'), 'no tag here');
  const untagged = new ReminderLog(); untagged.say('no tag here');
  assert.equal(untagged.say('no tag here'), '[System] Still applies (see above).');
});
