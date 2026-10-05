const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLocalInvariantAudit } = require('../out/localInvariantAudit.js');

test('stateful edits surface nearby lifecycle branches without hidden-test knowledge', () => {
  const source = `
function onLine(trimmed) {
  let streamEnded = false;
  let gotTerminal = false;
  if (trimmed === 'data: [DONE]') { gotTerminal = true; pushEnd(); }
  const finishReason = json.choices?.[0]?.finish_reason;
  if (finishReason && finishReason !== 'stop') push({ type: 'finish', reason: finishReason });
  res.on('end', () => {
    if (!gotTerminal && !streamEnded) push({ type: 'stream_error', message: 'premature' });
    pushEnd();
  });
  res.on('error', handleError);
}
`.trim();
  const changed = "let gotTerminal = false;\nif (trimmed === 'data: [DONE]') { gotTerminal = true; pushEnd(); }";
  const audit = buildLocalInvariantAudit(source, changed);
  assert.match(audit, /Local invariant audit/);
  assert.match(audit, /finishReason/);
  assert.match(audit, /res\.on\('end'/);
  assert.match(audit, /res\.on\('error'/);
  assert.match(audit, /resource\/transport closure distinct from semantic completion/i);
});

test('ordinary non-state edits do not add invariant noise', () => {
  const audit = buildLocalInvariantAudit('const sum = a + b;\nreturn sum;', 'const sum = a + b;');
  assert.equal(audit, '');
});
