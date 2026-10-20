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
  assert.match(contract, /every form, path or caller it names/);
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

test('nothing is derived from the request by splitting sentences: a problem statement is not a constraint, and no rule is cut from its cases', () => {
  const request = 'The orchestrator knows its workers only by an 8-character id, and models mix them up. Let it name them:\n- The start action takes an optional name, in both the fenced form and native calls. It is cleaned: "Front End!" becomes front-end.\n- A name already used gets a number.\n- Workers are shown as <name> (<id>).\n- The host\'s openWindow becomes launch.';
  const contract = buildTaskAcceptanceContract(request);
  assert.doesNotMatch(contract, /preservation \/ negative constraints/);
  assert.doesNotMatch(contract, /checklist derived/);
  // The request is whole, every bullet in it
  assert.ok(contract.includes(request));
});

test('normalization must be checked at every public input boundary, not just storage', () => {
  const contract = buildTaskAcceptanceContract('Accept a name in both the fenced and native tool form; clean "Fancy UI!" into fancy-ui.');
  assert.match(contract, /the converted value must come out of every entry point the request names, not only out of a later step/);
  assert.match(contract, /test each through its own entry point and check what it returns/);
  assert.match(contract, /returns a value unconverted where the request converts it is a failing test of the request/);
});

test('task contract states general rules, not one task\'s internal entry points', () => {
  const contract = buildTaskAcceptanceContract('Clean the name in both tool forms.');
  assert.doesNotMatch(contract, /owning action or service|DIRECTLY|EACH|RETURN|UNCONVERTED/);
});
