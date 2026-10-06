const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTaskAcceptanceContract, taskLikelyRequiresMutation } = require('../out/taskAcceptance.js');

test('task acceptance contract preserves outcomes and implementation discipline', () => {
  const contract = buildTaskAcceptanceContract(
    'Improve repeated-tool loop detection so fingerprints include tool arguments. Keep normal calls unchanged. Do not collapse different paths.'
  );

  assert.match(contract, /fingerprints include tool arguments/);
  assert.match(contract, /Keep normal calls unchanged/);
  assert.match(contract, /Do not collapse different paths/);
  assert.match(contract, /Acceptance checklist derived from the request/);
  assert.match(contract, /abstraction or API boundary that owns the behavior/i);
  assert.match(contract, /do not optimize for guessed hidden tests/i);
  assert.match(contract, /production caller\/path actually invokes that helper/i);
});

test('task acceptance contract stays bounded for enormous prompts', () => {
  assert.ok(buildTaskAcceptanceContract('Fix this. Keep behavior unchanged. ' + 'x'.repeat(10000)).length < 6500);
});


test('mutation intent is detected conservatively for coding requests', () => {
  assert.equal(taskLikelyRequiresMutation(
    'When an interrupted stream resumes, prevent repeated text at the seam. Add a general overlap calculation.'
  ), true);
  assert.equal(taskLikelyRequiresMutation('Explain how stream resumption currently works.'), false);
  assert.equal(taskLikelyRequiresMutation('Review the current implementation and summarize risks.'), false);
});
