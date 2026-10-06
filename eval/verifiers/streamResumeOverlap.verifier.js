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
  return value.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
}

test('resume overlap calculation removes repeated seam text without trimming new content', () => {
  const candidate = findOverlapCandidate();
  assert.ok(candidate, 'expected a reusable exported overlap calculation in streamCompletion');

  const providerSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'agentProvider.ts'),
    'utf8',
  );
  assert.match(
    providerSource,
    new RegExp('\\b' + escapeRegex(candidate.name) + '\\b'),
    'the overlap calculation must be used by the resume path',
  );
});
