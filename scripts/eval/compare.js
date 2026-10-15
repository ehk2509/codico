/**
 * Compares two holdout results (Codico against a reference agent, or two Codico versions or
 * models), task by task on the same frozen tasks:
 *
 *   node scripts/eval/compare.js eval/results/<run A> eval/results/<run B>
 *
 * Writes the comparison as Markdown to stdout. A task counts for A when A's success rate on
 * it is higher than B's; the sign test says how likely a split this uneven is by chance.
 */
const fs = require('node:fs');
const path = require('node:path');
const { summarizeQuality, TARGETS } = require('./quality');

function loadRecords(dir) {
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.json') && name !== 'summary.json' && !name.endsWith('-agent.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
    .filter(record => record && record.taskId);
}

function label(dir, records) {
  const first = records[0] || {};
  return `${first.agent || 'codico'}${first.model ? ` (${first.model})` : ''} — ${path.basename(dir)}`;
}

/** Two-sided sign test: the chance of a split at least this uneven between wins and losses. */
function signTest(wins, losses) {
  const n = wins + losses;
  if (!n) { return 1; }
  const k = Math.min(wins, losses);
  let tail = 0;
  for (let i = 0; i <= k; i++) { tail += binomial(n, i); }
  return Math.min(1, 2 * tail / 2 ** n);
}
function binomial(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) { r = r * (n - k + i) / i; }
  return r;
}

/** Per task: how often each side passed, and what it cost. */
function pairTasks(a, b) {
  const tasks = new Map();
  for (const [side, records] of [['a', a], ['b', b]]) {
    for (const r of records) {
      if (r.invalidVerifier || !r.setupOk) { continue; }
      const entry = tasks.get(r.taskId) || { id: r.taskId, a: [], b: [] };
      entry[side].push(r);
      tasks.set(r.taskId, entry);
    }
  }
  return [...tasks.values()].filter(t => t.a.length && t.b.length).sort((x, y) => x.id.localeCompare(y.id));
}

const passRate = runs => runs.filter(r => r.success).length / runs.length;
const cost = runs => runs.every(r => r.quality && r.quality.costUsd !== null && r.quality.costUsd !== undefined) ? runs.reduce((n, r) => n + r.quality.costUsd, 0) / runs.length : null;
const pct = v => v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`;
const usd = v => v === null || v === undefined ? 'n/a' : `$${v.toFixed(4)}`;

function compare(dirA, dirB) {
  const a = loadRecords(dirA);
  const b = loadRecords(dirB);
  const paired = pairTasks(a, b);
  const ids = new Set(paired.map(t => t.id));
  const qa = summarizeQuality(a.filter(r => ids.has(r.taskId)));
  const qb = summarizeQuality(b.filter(r => ids.has(r.taskId)));
  let wins = 0, losses = 0;
  const rows = paired.map(t => {
    const ra = passRate(t.a), rb = passRate(t.b);
    if (ra > rb) { wins++; } else if (rb > ra) { losses++; }
    return `| ${t.id} | ${t.a.filter(r => r.success).length}/${t.a.length} | ${t.b.filter(r => r.success).length}/${t.b.length} | ${ra > rb ? 'A' : rb > ra ? 'B' : '='} | ${usd(cost(t.a))} | ${usd(cost(t.b))} |`;
  });
  const measure = (key, title = TARGETS[key] ? TARGETS[key].label : key) => `| ${title} | ${pct(qa[key].value)} (${qa[key].numerator}/${qa[key].denominator}) | ${pct(qb[key].value)} (${qb[key].numerator}/${qb[key].denominator}) |`;
  return [
    '# Holdout comparison',
    '',
    `**A**: ${label(dirA, a)}`,
    `**B**: ${label(dirB, b)}`,
    '',
    `${paired.length} tasks run by both${a.length + b.length > 0 && ids.size < new Set([...a, ...b].map(r => r.taskId)).size ? ' (tasks only one side ran are left out)' : ''}.`,
    `A better on **${wins}**, B better on **${losses}**, equal on **${paired.length - wins - losses}** — sign test p = ${signTest(wins, losses).toFixed(3)}${paired.length < 20 ? ' (few tasks: read with care)' : ''}.`,
    '',
    '| Measure | A | B |',
    '|---|---:|---:|',
    measure('taskSuccess'),
    measure('firstAttempt'),
    measure('regressionFree'),
    measure('testVerification'),
    measure('recovery'),
    measure('editPrecision'),
    measure('falseCompletion'),
    `| Cost per verified success | ${usd(qa.costPerSuccessUsd)} | ${usd(qb.costPerSuccessUsd)} |`,
    `| Tokens per verified success | ${qa.tokensPerSuccess === null ? 'n/a' : Math.round(qa.tokensPerSuccess).toLocaleString('en-US')} | ${qb.tokensPerSuccess === null ? 'n/a' : Math.round(qb.tokensPerSuccess).toLocaleString('en-US')} |`,
    '',
    '| Task | A passed | B passed | Better | A cost/run | B cost/run |',
    '|---|---:|---:|:---:|---:|---:|',
    ...rows,
    '',
  ].join('\n');
}

if (require.main === module) {
  const [dirA, dirB] = process.argv.slice(2);
  if (!dirA || !dirB) {
    console.error('Usage: node scripts/eval/compare.js <results A> <results B>');
    process.exit(2);
  }
  console.log(compare(path.resolve(dirA), path.resolve(dirB)));
}

module.exports = { compare, signTest, pairTasks, loadRecords };
