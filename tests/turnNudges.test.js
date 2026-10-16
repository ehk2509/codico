const test = require('node:test');
const assert = require('node:assert/strict');
const { TurnNudges, Escalation, ASK_TO_FINISH, ASK_FOR_ANSWER, BATCH_HINT } = require('../out/turnNudges.js');

test('a batching hint after two single-read steps, once, on the next read', () => {
  const n = new TurnNudges();
  n.stepDone(1, 0); assert.equal(n.batchHint(1), '');
  n.stepDone(1, 0); assert.equal(n.batchHint(1), `\n\n${BATCH_HINT}`);
  n.stepDone(1, 0); n.stepDone(1, 0); assert.equal(n.batchHint(1), '', 'once per turn');
  const m = new TurnNudges();
  m.stepDone(1, 0); m.stepDone(3, 0); m.stepDone(1, 0); assert.equal(m.batchHint(1), '', 'a batched step breaks the run');
  m.stepDone(1, 1); m.stepDone(1, 0); assert.equal(m.batchHint(1), '', 'a step with other tools too breaks it');
});

test('an offer or a question with the work unfinished is sent back once; a silent end is asked for its answer once', () => {
  const n = new TurnNudges();
  assert.equal(n.askToFinish('Done: the tests pass.', true, () => true), undefined);
  assert.equal(n.askToFinish("It is written. Say the word and I'll wire it in.", true, () => false), undefined, 'the work is accepted');
  assert.equal(n.askToFinish('Which do you want?', false, () => true), undefined, 'no tool ran: a real question');
  assert.equal(n.askToFinish('Which do you want?', true, () => true), ASK_TO_FINISH);
  assert.equal(n.askToFinish('Which do you want?', true, () => true), undefined, 'once');
  assert.equal(n.askForAnswer('', true), ASK_FOR_ANSWER);
  assert.equal(n.askForAnswer('', true), undefined);
  assert.equal(new TurnNudges().askForAnswer('All done.', true), undefined);
});

test('escalation: once, to the configured model, only with an OpenRouter key and when it is another model', () => {
  const said = [];
  const e = new Escalation('anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5', true, t => said.push(t));
  assert.equal(e.escalate('the reviewer disputes it'), true);
  assert.equal(e.model, 'anthropic/claude-sonnet-5.5');
  assert.match(said[0], /Handing the rest of this task to anthropic\/claude-sonnet-5\.5: the reviewer disputes it/);
  assert.equal(e.escalate('again'), false);
  assert.equal(new Escalation('', 'm', true, () => {}).escalate('x'), false, 'off');
  assert.equal(new Escalation('m2', 'm', false, () => {}).escalate('x'), false, 'no key');
  assert.equal(new Escalation('m', 'm', true, () => {}).escalate('x'), false, 'already that model');
});
