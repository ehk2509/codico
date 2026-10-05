const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function extractNamedFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) { return null; }

  const brace = source.indexOf('{', start);
  if (brace < 0) { return null; }

  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === '\n') { lineComment = false; }
      continue;
    }

    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i++; }
      continue;
    }

    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) { quote = null; }
      continue;
    }

    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }

    if (ch === '{') { depth++; }
    if (ch === '}') {
      depth--;
      if (depth === 0) { return source.slice(start, i + 1); }
    }
  }

  return null;
}

function loadFingerprint() {
  try {
    const exported = require('../out/toolParser.js').toolFingerprint;
    if (typeof exported === 'function') { return exported; }
  } catch {}

  const agentPath = path.join(__dirname, '..', 'out', 'agentProvider.js');
  const source = fs.readFileSync(agentPath, 'utf8');
  const functionSource = extractNamedFunction(source, '_toolFingerprint');
  if (!functionSource) {
    throw new Error('No executable repeated-tool fingerprint implementation was found.');
  }

  return Function('"use strict"; return (' + functionSource + ');')();
}

test('tool fingerprints distinguish calls by their arguments', () => {
  const fingerprint = loadFingerprint();

  const writeA = { type: 'write_file', filepath: 'src/A.js', content: 'a' };
  const writeB = { type: 'write_file', filepath: 'src/B.js', content: 'b' };
  const writeDifferentContent = { type: 'write_file', filepath: 'src/A.js', content: 'b' };
  const runLs = { type: 'run_terminal', command: 'ls' };
  const runPwd = { type: 'run_terminal', command: 'pwd' };

  assert.notEqual(fingerprint(writeA), fingerprint(writeB));
  assert.notEqual(fingerprint(writeA), fingerprint(writeDifferentContent));
  assert.notEqual(fingerprint(runLs), fingerprint(runPwd));
  assert.equal(fingerprint(writeA), fingerprint({ ...writeA }));
});
