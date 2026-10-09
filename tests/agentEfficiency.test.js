const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isExplorationTool,
  isMutationTool,
  explorationGuidance,
  explorationDecision,
  explorationTarget,
  isExploratoryTerminalCommand,
} = require('../out/agentEfficiency.js');

test('focused exploration policy distinguishes reads from mutations', () => {
  assert.equal(isExplorationTool({ type: 'read_file', filepath: 'src/a.ts' }), true);
  assert.equal(isExplorationTool({ type: 'search_files', pattern: 'foo', isRegex: false }), true);
  assert.equal(isExplorationTool({ type: 'run_terminal', command: 'npm test' }), false);
  assert.equal(isMutationTool({ type: 'edit_file', filepath: 'a', oldStr: 'x', newStr: 'y' }), true);
});

test('exploration transitions into action phase after six evidence calls', () => {
  assert.equal(explorationGuidance(5), null);

  const action = explorationDecision(6, 1);
  assert.equal(action.lock, true);
  assert.equal(action.block, undefined);
  assert.match(action.guidance, /make the smallest evidence-backed code change/i);

  const later = explorationDecision(14, 1);
  assert.equal(later.lock, true);
  assert.equal(later.block, undefined);
});

test('repeated targets become stronger guidance without capability withdrawal', () => {
  assert.equal(explorationTarget({ type: 'read_file', filepath: 'src/a.ts', startLine: 1, endLine: 100 }), 'read_file:src/a.ts');
  assert.equal(explorationTarget({ type: 'read_file', filepath: 'src/a.ts', startLine: 200, endLine: 300 }), 'read_file:src/a.ts');

  const early = explorationDecision(5, 3);
  assert.equal(early.lock, undefined);
  assert.equal(early.block, undefined);
  assert.match(early.guidance, /inspected this target repeatedly/i);

  const action = explorationDecision(6, 3);
  assert.equal(action.lock, true);
  assert.equal(action.block, undefined);
  assert.match(action.guidance, /revisited this target repeatedly/i);
});

test('terminal source inspection remains identifiable without being a hard lock', () => {
  assert.equal(isExploratoryTerminalCommand("grep -rn 'StreamChunk' src/"), true);
  assert.equal(isExploratoryTerminalCommand('git grep StreamChunk -- src'), true);
  assert.equal(isExploratoryTerminalCommand('cat src/openRouterClient.ts'), true);
  assert.equal(isExploratoryTerminalCommand('cd /tmp/workspace && grep -rn foo src/'), true);
  assert.equal(isExploratoryTerminalCommand('cd /tmp/workspace; cat src/a.ts'), true);
  assert.equal(isExploratoryTerminalCommand('npm test'), false);
  assert.equal(isExploratoryTerminalCommand('npm run compile'), false);
});

test('documentation and plain-text files are recognised', () => {
  const { isDocumentationFile } = require('../out/agentEfficiency.js');
  for (const f of ['README.md', 'docs/guide.markdown', 'notes.txt', 'a/b/INDEX.rst', 'manual.adoc', 'LICENSE', 'CHANGELOG', 'dir\\Notes.TXT']) {
    assert.equal(isDocumentationFile(f), true, f);
  }
  for (const f of ['src/app.ts', 'page.mdx', 'Makefile', 'config.json', 'script.py', '.env', 'readme.md.ts']) {
    assert.equal(isDocumentationFile(f), false, f);
  }
});

test('search patterns that are clearly regexes are recognised when regex mode was omitted', () => {
  const { looksLikeIntendedRegex } = require('../out/agentEfficiency.js');
  for (const p of ['system|SYSTEM', 'systemPrompt|SYSTEM_PROMPT', 'export const (DEFAULT_SYSTEM_PROMPT|S_SYSTEM)', '\\bfoo\\b', 'get.*Name', '^import ', 'end;$', 'v[0-9]+']) {
    assert.equal(looksLikeIntendedRegex(p), true, p);
  }
  for (const p of ['You are Codico', 'streamOpenRouter', 'a.b', 'call(x)', 'unbalanced (paren', '[System Verification]']) {
    assert.equal(looksLikeIntendedRegex(p), false, p);
  }
});
