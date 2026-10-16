/**
 * One scorecard for a run split into several (each a results folder, such as the artifacts
 * of several Coding Holdout workflow runs):
 *
 *   node scripts/eval/summarize.js <results folder>...
 *
 * Folders are searched recursively for run records. A task found more than once counts each
 * run, as repetitions do.
 */
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { summarizeQuality, scorecardMarkdown, claimedCompletion, stoppedMidWork, unrelatedFiles } = require('./quality');

/** The measures read from the reply and the edit precision, again with the current rules (records keep what they rest on). */
function rescore(record) {
  if (!record.quality) { return record; }
  const claimed = claimedCompletion(record.finalReply);
  const maxSteps = (record.agent || 'codico') === 'codico' ? record.maxIterations : 0;
  // Older records do not list the files the agent created: a file absent at the base was created
  const root = path.resolve(__dirname, '../..');
  const newFiles = record.newFiles || (record.changedFiles || []).filter(file => record.baseCommit &&
    cp.spawnSync('git', ['cat-file', '-e', `${record.baseCommit}:${file}`], { cwd: root }).status !== 0);
  const unrelated = record.referenceFiles ? unrelatedFiles(record.changedFiles || [], record.referenceFiles, newFiles) : record.quality.unrelatedFiles;
  return { ...record, quality: { ...record.quality, claimed, falseCompletion: claimed && !record.success, unrelatedFiles: unrelated,
    stoppedAtLimit: stoppedMidWork(record.finalReply) && !!maxSteps && (record.metrics?.steps || 0) >= maxSteps } };
}

/** Every run record under a folder (not summaries, not Codico's raw agent output). */
function findRecords(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { return findRecords(full); }
    if (!entry.name.endsWith('.json') || entry.name === 'summary.json' || entry.name.endsWith('-agent.json')) { return []; }
    try {
      const record = JSON.parse(fs.readFileSync(full, 'utf8'));
      return record && record.taskId ? [record] : [];
    } catch { return []; }
  });
}

function summarize(dirs) {
  const records = dirs.flatMap(findRecords).map(rescore).sort((a, b) => a.taskId.localeCompare(b.taskId) || (a.repetition || 1) - (b.repetition || 1));
  const first = records[0] || {};
  const rows = records.map(r => {
    const q = r.quality || {};
    const result = r.invalidVerifier ? 'INVALID' : r.success ? 'PASS' : 'FAIL';
    return `| ${r.taskId} | ${r.category} | ${result}${q.stoppedAtLimit ? ' (cut off)' : ''} | ${r.metrics?.steps ?? '-'} | ${r.metrics?.totalTokens?.toLocaleString('en-US') ?? '-'} | ${q.evidence ?? '-'} | ${q.claimed === undefined ? '-' : q.claimed ? 'yes' : 'no'} | ${q.regressions ? q.regressions.length : '-'} | ${q.unrelatedFiles ? q.unrelatedFiles.length : '-'} |`;
  });
  return [
    `# Codico coding holdout — ${first.suiteVersion || '?'}`,
    '',
    `Agent: **${first.agent || 'codico'}**${first.model ? ` · model: **${first.model}**` : ''} · ${records.length} runs from ${dirs.length} result folder${dirs.length === 1 ? '' : 's'}`,
    '',
    '| Task | Category | Result | Steps | Tokens | Evidence | Claimed done | Regressions | Unrelated files |',
    '|---|---|---|---:|---:|---|:---:|---:|---:|',
    ...rows,
    '',
    scorecardMarkdown(summarizeQuality(records)),
  ].join('\n');
}

if (require.main === module) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) {
    console.error('Usage: node scripts/eval/summarize.js <results folder>...');
    process.exit(2);
  }
  console.log(summarize(dirs.map(dir => path.resolve(dir))));
}

module.exports = { summarize, findRecords };
