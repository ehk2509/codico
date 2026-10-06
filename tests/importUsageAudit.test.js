const test = require('node:test');
const assert = require('node:assert/strict');
const { buildImportUsageAudit } = require('../out/importUsageAudit.js');
const { buildLocalInvariantAudit } = require('../out/localInvariantAudit.js');

test('new helper import without a call produces an integration warning', () => {
  const source = [
    "import { isRecoverableStreamInterruption, normalizeFinishReason, computeOverlap } from './streamCompletion';",
    'const a = isRecoverableStreamInterruption("network");',
    'const b = normalizeFinishReason("stop");',
  ].join('\n');
  const audit = buildLocalInvariantAudit(source, source.split('\n')[0]);
  assert.match(audit, /\[Post-edit integration audit\]/);
  assert.match(audit, /computeOverlap from \.\/streamCompletion/);
  assert.doesNotMatch(audit, /isRecoverableStreamInterruption from/);
  assert.match(audit, /import alone is not integration/i);
});

test('integration audit clears after the imported helper is invoked', () => {
  const source = [
    "import { computeOverlap } from './streamCompletion';",
    'const deduped = incoming.slice(computeOverlap(previous, incoming));',
  ].join('\n');
  assert.equal(buildImportUsageAudit(source), '');
});

test('aliased local imports are tracked by the alias used in the consumer', () => {
  const pending = "import { original as dedupe } from './helpers';\nconst x = 1;";
  assert.match(buildImportUsageAudit(pending), /dedupe from \.\/helpers/);
  const wired = pending + '\nconst length = dedupe(previous, next);';
  assert.equal(buildImportUsageAudit(wired), '');
});

test('type-only, package, and side effect imports are not gated', () => {
  const source = [
    "import type { Foo } from './types';",
    "import { type Bar } from './types';",
    "import { external } from 'external-package';",
    "import './register';",
  ].join('\n');
  assert.equal(buildImportUsageAudit(source), '');
});

test('unrelated ordinary edit produces no audit noise', () => {
  assert.equal(buildLocalInvariantAudit('const answer = 42;', 'const answer = 42;'), '');
});
