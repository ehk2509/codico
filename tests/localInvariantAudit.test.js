const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLocalInvariantAudit } = require('../out/localInvariantAudit.js');

test('stateful edits classify semantic completion separately from transport closure', () => {
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
  assert.match(audit, /Semantic completion \/ normal terminal candidates/);
  assert.match(audit, /finishReason/);
  assert.match(audit, /Transport closure \/ failure candidates/);
  assert.match(audit, /res\.on\('end'/);
  assert.match(audit, /res\.on\('error'/);
  assert.match(audit, /every semantic completion\/normal-terminal candidate/i);
  assert.match(audit, /explicit sentinel and a provider finish\/completion field/i);
  assert.match(audit, /resource\/transport closure distinct from semantic completion/i);
});

test('ordinary non-state edits do not add invariant noise', () => {
  const audit = buildLocalInvariantAudit('const sum = a + b;\nreturn sum;', 'const sum = a + b;');
  assert.equal(audit, '');
});
