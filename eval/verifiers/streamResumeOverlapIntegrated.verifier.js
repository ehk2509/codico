const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function transformFromCandidate(fn, previous, continuation) {
  let result;
  try {
    result = fn(previous, continuation);
  } catch {
    return null;
  }

  if (Number.isInteger(result) && result >= 0 && result <= continuation.length) {
    return continuation.slice(result);
  }
  if (typeof result === 'string') {
    return result;
  }
  return null;
}

function findOverlapCandidate() {
  const mod = require('../out/streamCompletion.js');
  const cases = [
    {
      previous: 'API service is ready.\n\nNow creating the component files, starting with the price',
      continuation: 'Now creating the component files, starting with the price ticker and chart.',
      expected: ' ticker and chart.',
    },
    {
      previous: 'API service is ready.\n\nNow creating the component files, starting with the price',
      continuation: ' ticker and chart components.',
      expected: ' ticker and chart components.',
    },
    {
      previous: 'API service is ready.\nNow creating the component',
      continuation: '\nNow creating the component',
      expected: '',
    },
    {
      previous: '',
      continuation: 'anything',
      expected: 'anything',
    },
    {
      previous: 'alpha beta gamma',
      continuation: 'unrelated continuation',
      expected: 'unrelated continuation',
    },
  ];

  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== 'function') { continue; }
    if (/^class\s/.test(Function.prototype.toString.call(value))) { continue; }

    const outputs = cases.map(({ previous, continuation }) =>
      transformFromCandidate(value, previous, continuation)
    );
    if (outputs.every((output, index) => output === cases[index].expected)) {
      return { name, fn: value };
    }
  }

  return null;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^$()|[\]{}\\]/g, '\\function escapeRegex(value) {
  return value.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
}

test('resume overlap calculation is applied at the recovery seam', () => {
');
}

function exportedFunctionBodies(source) {
  const bodies = new Map();
  const declaration = /export\\s+(?:async\\s+)?function\\s+([A-Za-z_$][\\w$]*)\\s*\\(/g;
  let match;
  while ((match = declaration.exec(source)) !== null) {
    const name = match[1];
    const openBrace = source.indexOf('{', declaration.lastIndex);
    if (openBrace < 0) { continue; }
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let i = openBrace; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\\\') { escaped = true; continue; }
        if (ch === quote) { quote = null; }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '{') { depth++; }
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          bodies.set(name, source.slice(openBrace + 1, i));
          declaration.lastIndex = i + 1;
          break;
        }
      }
    }
  }
  return bodies;
}

function integratedRecoveryCall(providerSource, streamSource, candidateName) {
  const accepted = new Set([candidateName]);
  const bodies = exportedFunctionBodies(streamSource);

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, body] of bodies) {
      if (accepted.has(name)) { continue; }
      for (const dependency of accepted) {
        if (new RegExp('\\\\b' + escapeRegex(dependency) + '\\\\s*\\\\(').test(body)) {
          accepted.add(name);
          changed = true;
          break;
        }
      }
    }
  }

  for (const name of accepted) {
    const callPattern = new RegExp('\\\\b' + escapeRegex(name) + '\\\\s*\\\\(');
    const callIndex = providerSource.search(callPattern);
    if (callIndex < 0) { continue; }
    const nearby = providerSource.slice(Math.max(0, callIndex - 1200), callIndex + 1600);
    if (/resume|recover|cutoff|partial|continuation|buffer|overlap/i.test(nearby)) {
      return name;
    }
  }
  return null;
}

test('resume overlap calculation is applied at the recovery seam', () => {
  const candidate = findOverlapCandidate();
  assert.ok(candidate, 'expected a reusable exported overlap calculation in streamCompletion');

  const providerSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'agentProvider.ts'),
    'utf8',
  );

  const streamSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'streamCompletion.ts'),
    'utf8',
  );

  const integratedName = integratedRecoveryCall(providerSource, streamSource, candidate.name);
  assert.ok(
    integratedName,
    'the overlap calculation must be used directly or through an exported streamCompletion recovery helper called by the agent resume path',
  );
});
