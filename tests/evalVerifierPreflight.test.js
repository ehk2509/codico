const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { referencedOutModules, missingVerifierOutModules } = require('../scripts/eval/verifierPreflight.js');

test('verifier preflight detects historical module incompatibility', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-verifier-'));
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'toolParser.ts'), 'export {};');

  const source = [
    "require('../out/toolParser.js');",
    "require('../out/streamCompletion.js');",
  ].join('\n');

  assert.deepEqual(referencedOutModules(source), ['toolParser.js', 'streamCompletion.js']);
  assert.deepEqual(missingVerifierOutModules(source, workspace), ['streamCompletion.js']);

  fs.rmSync(workspace, { recursive: true, force: true });
});
