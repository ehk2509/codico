const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hashIndexText,
  canReusePersistedVector,
} = require('../out/indexPersistence.js');

test('hashIndexText is stable and content-sensitive', () => {
  assert.equal(hashIndexText('const a = 1;'), hashIndexText('const a = 1;'));
  assert.notEqual(hashIndexText('const a = 1;'), hashIndexText('const a = 2;'));
});

test('persisted vectors are reused only for matching current source', () => {
  const text = '// src/a.ts\nconst a = 1;';
  const persisted = {
    file: 'src/a.ts',
    startLine: 1,
    vector: [0.1, 0.2, 0.3],
    textHash: hashIndexText(text),
  };

  assert.equal(canReusePersistedVector(text, persisted), true);
  assert.equal(canReusePersistedVector('// src/a.ts\nconst a = 2;', persisted), false);
  assert.equal(canReusePersistedVector(text, { ...persisted, vector: undefined }), false);
  assert.equal(canReusePersistedVector(text, { ...persisted, textHash: undefined }), false);
});
