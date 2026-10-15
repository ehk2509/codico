/**
 * Agents other than Codico, run on the same holdout tasks for comparison:
 * - claude-code: Claude Code headless (`claude -p`), its evidence read from its stream of events;
 * - oracle: applies the historical fix itself — every task should pass with it, so a failure
 *   shows a broken task or verifier, not a weak agent.
 */
const cp = require('node:child_process');

/** The text of a tool result's content (a string, or text blocks). */
function resultText(content) {
  if (typeof content === 'string') { return content; }
  return Array.isArray(content) ? content.map(block => block && block.type === 'text' ? block.text : '').join('\n') : '';
}

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/**
 * What a Claude Code run did, from its stream-json events: the change report built from the
 * commands it ran and their results (the same recorder Codico uses), its final reply, and its
 * usage and cost as Claude Code reported them.
 * @param PassportRecorder Codico's recorder (out/patchPassport.js)
 */
function claudeCodeEvidence(stdout, PassportRecorder) {
  const recorder = new PassportRecorder();
  const tools = new Map();
  let result = null;
  let toolCalls = 0;
  let edits = 0;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) { continue; }
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const content = event.message && Array.isArray(event.message.content) ? event.message.content : [];
    if (event.type === 'assistant') {
      for (const block of content) {
        if (block.type === 'tool_use') { tools.set(block.id, block); toolCalls++; }
      }
    } else if (event.type === 'user') {
      for (const block of content) {
        if (block.type !== 'tool_result') { continue; }
        const tool = tools.get(block.tool_use_id);
        if (!tool) { continue; }
        if (tool.name === 'Bash' && tool.input && tool.input.command) {
          recorder.recordCommand(tool.input.command, block.is_error ? 1 : 0, resultText(block.content));
        } else if (FILE_TOOLS.has(tool.name) && !block.is_error && tool.input) {
          // Only when it changed matters here; what the lines were is read from git
          recorder.recordChange(tool.input.file_path || tool.input.notebook_path || '?', '', `edit ${++edits}`);
        }
      }
    } else if (event.type === 'result') {
      result = event;
    }
  }
  const usage = (result && result.usage) || {};
  const promptTokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const completionTokens = usage.output_tokens || 0;
  return {
    passport: recorder.build() || null,
    finalReply: result && typeof result.result === 'string' ? result.result : '',
    ok: !!result && !result.is_error,
    costUsd: result && Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null,
    metrics: {
      durationMs: (result && result.duration_ms) || 0,
      steps: (result && result.num_turns) || 0,
      toolCalls,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
  };
}

/**
 * Runs Claude Code on the task in its workspace. It runs with every permission granted
 * (--dangerously-skip-permissions), as a benchmark run must not stop for approvals: the
 * workspace is a throwaway worktree, but the commands run on this machine.
 */
function runClaudeCode(workspace, prompt, { model, timeoutMs, PassportRecorder, command = 'claude' }) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', ...(model ? ['--model', model] : [])];
  const run = cp.spawnSync(command, args, { cwd: workspace, encoding: 'utf8', timeout: timeoutMs || undefined, maxBuffer: 256 * 1024 * 1024 });
  if (run.error && run.error.code === 'ENOENT') { throw new Error(`Claude Code is not installed: "${command}" was not found.`); }
  const evidence = claudeCodeEvidence(run.stdout, PassportRecorder);
  return { ...evidence, ok: evidence.ok && run.status === 0, timedOut: !!run.error && /ETIMEDOUT/.test(String(run.error)), stderr: run.stderr || '' };
}

/** The files the historical fix changed: what the agent is compared against. */
function referenceFiles(root, baseCommit, fixCommit) {
  const diff = cp.spawnSync('git', ['diff', '--name-only', baseCommit, fixCommit], { cwd: root, encoding: 'utf8' });
  return diff.status === 0 ? diff.stdout.split(/\r?\n/).filter(Boolean) : null;
}

/** The oracle: the historical fix's source changes, applied to the workspace (its tests are left out: they are the verifier's). */
function applyOracle(root, workspace, baseCommit, fixCommit) {
  const patch = cp.spawnSync('git', ['diff', '--binary', baseCommit, fixCommit, '--', '.', ':(exclude)tests', ':(exclude)eval', ':(exclude)*.md'], { cwd: root, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (patch.status !== 0) { throw new Error(`git diff of the reference fix failed: ${patch.stderr}`); }
  if (!patch.stdout.length) { return { ok: true, finalReply: 'The reference fix changes no source file.' }; }
  const apply = cp.spawnSync('git', ['apply', '--whitespace=nowarn'], { cwd: workspace, input: patch.stdout, encoding: 'utf8' });
  return apply.status === 0
    ? { ok: true, finalReply: `Applied the reference fix (${fixCommit.slice(0, 12)}).` }
    : { ok: false, finalReply: `The reference fix did not apply: ${apply.stderr.trim()}` };
}

module.exports = { claudeCodeEvidence, runClaudeCode, referenceFiles, applyOracle };
