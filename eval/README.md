# Codico coding holdout

Codico's coding-quality evidence is measured with a frozen historical-regression suite rather than toy generation prompts.

## Frozen suite v7

`eval/tasks.json` contains **30 tasks** from historical Codico bug fixes and features. Every one is proven valid:

- **Its hidden verifier fails with no change.** `--agent noop` fails all 30.
- **It passes with the historical fix applied.** `--agent oracle` passes all 30.

That gives 30 scored tasks, against the 9 that v6 could score (see the audit below).

- **9 tasks carried over from v6, unchanged:** the ones that can be scored.
- **21 tasks mined from fix commits** with `scripts/eval/mine.js`.
  - A candidate is a commit that changed source files and a unit-test file.
  - The tests it added are run at its parent, with only the new test file in place; the ones that fail there make up the task's verifier.
  - The commit's source changes are then applied, and the same tests must pass twice.
  - Commits whose tests load a module the fix itself created are rejected.
- **Selection:** of the 32 valid commits, these 21 were kept because their tested behaviour can be stated in a prompt without dictating test wording. Some tasks use only a subset of a commit's new tests, for the same reason.
- **Prompts:** each reads like an issue report or feature request, and names a function or module only when the hidden test imports one that does not exist yet.
- **Categories:** tool parsing, context management, agent loop, chat panel, providers, streaming, security, terminal and native tools.

Like v6, v7 has no evaluator ceilings:

- **no evaluator wall-clock timeout** (`maxTaskMinutes: 0`);
- **no cumulative token ceiling** (`maxTotalTokens: 0`).

While a required change or post-edit verification is pending the iteration budget does not stop the agent; a turn ends once the model stops calling tools after 3 consecutive reminders. Writes to documentation and plain-text files do not require verification. Hidden verifiers still determine correctness. Periodic checkpoints preserve evidence if the host or CI process is interrupted externally.

Burned v1-v6 suites remain archived as `eval/tasks-v1.json` through `eval/tasks-v6.json`. v5 retains its original 15-minute / 400k-token policy for reproducibility.

Finding more candidates (for a future version):

```bash
node scripts/eval/mine.js --jobs 4 --out eval/results/mined-candidates.json
```

### Execution protocol

For every task the runner:

1. creates a detached worktree at the historical pre-fix commit;
2. installs that commit's dependencies;
3. loads the hidden verifier outside the task workspace and checks that its compiled-module dependencies exist in that historical source tree;
4. skips invalid verifier/base combinations before any model request;
5. launches the current Codico extension in a unique VS Code user-data/extensions profile;
6. lets the real agent solve the task with real tools;
7. captures metrics and the agent diff;
8. injects the hidden verifier only after the agent stops;
9. runs the verifier;
10. kills any Electron processes carrying that unique profile path and removes the worktree.

This keeps hidden tests invisible to the agent, prevents broken historical verifiers from wasting credits, and isolates each VS Code instance so one interrupted run cannot poison the next task.

## Running locally

```bash
git fetch --unshallow  # if needed
export OPENROUTER_API_KEY=...
npm ci
npm run eval:coding -- --model deepseek/deepseek-v4-flash

# optional: impose a local wall-clock ceiling explicitly (0/default = none)
npm run eval:coding -- --timeout-minutes 30 --model deepseek/deepseek-v4-flash

# optional: impose a cumulative token ceiling explicitly (0/default = none)
npm run eval:coding -- --max-total-tokens 400000 --model deepseek/deepseek-v4-flash

# reproduce burned suites explicitly
npm run eval:coding -- --suite eval/tasks-v2.json --model deepseek/deepseek-v4-flash
npm run eval:coding -- --suite eval/tasks-v1.json --model deepseek/deepseek-v4-flash
```

Useful subsets:

```bash
npm run eval:coding -- --filter tools-fingerprint-arguments --limit 1
npm run eval:coding -- --filter streaming --repetitions 3
npm run eval:coding -- --limit 4
```

Results are written beneath `eval/results/` and are git-ignored.


## Quality scorecard

Passing the hidden verifier is necessary, not sufficient. Each run is also scored on what it proves beyond that, from what was observed rather than what the agent says. `summary.md` ends with the scorecard, and each run's record holds the facts behind it (`quality`, `evidence`, `finalReply`).

| Measure | Over | Counts when |
|---|---|---|
| Task success rate | tasks | the hidden verifier passed in at least one repetition (pass@k) |
| First-attempt success | runs | the hidden verifier passed (pass@1); with several repetitions, "solved in every repetition" is also reported |
| Regression-free rate | verified successes | no test of the project that passed before the agent fails after it. The project's whole suite runs before and after the agent, before the hidden verifier is added. A suite that no longer runs breaks every test. |
| Test verification | runs that changed files | a test command passed after the last change |
| Recovery success | runs where a check failed along the way | the hidden verifier passed in the end |
| Edit precision | verified successes | no source file changed outside those the historical fix changed (tests and docs aside) |
| False-completion rate | runs whose final reply presents the task as done | the hidden verifier rejected it |
| Cost per verified success | — | dollars for all valid runs ÷ verified successes |

For Codico, the commands and their results come from its change report (the patch passport). For Claude Code, they come from its own event stream, read with the same recorder. Prices come from OpenRouter's model list, or from `--price-in` / `--price-out` (dollars per million tokens). Claude Code reports its own cost.

The targets (85% task success, 75% first attempt, 95% regression-free, 95% test verification, 85% recovery, 90% edit precision, about 0% false completion) are proposed engineering targets, not industry standards.

Limits:

- **Claims:** whether a reply claims completion is judged from its wording.
- **Edit precision:** the reference is the diff from the base to the task's `fixCommit`, or to its `verifierCommit` when no `fixCommit` is set. Some of those commits carry other changes of their era, which makes the reference wider than the minimal fix.

Use `--no-regression-check` to skip the two extra test runs.

### Oracle audit of v6 (2026-10-15), the reason for v7

With the historical fix applied by the oracle, only **9 of the 26 tasks can be scored**, and all 9 pass:

- **16 tasks are skipped before any model request.** Each one's verifier imports a module that the historical fix itself created (`streamCompletion`, `nativeTools`, `networkSecurity`, `providerConversation`, `mcpEnvironment`, `terminalProcess`, `urlFetcher`, `browserNetworkPolicy`), so the module does not exist at the task's base. These are: stream-recoverable-classification, stream-finish-normalization, native-fragmented-arguments, native-malformed-arguments, network-block-private, network-dns-private, network-dns-pinning, mcp-environment-secrets, terminal-user-abort, url-html-sanitization, history-openai-tool-linkage, history-anthropic-tool-linkage, history-gemini-tool-linkage, history-compatibility-flattening, browser-private-network-policy and browser-private-network-optin.
- **`terminal-timeout` cannot load its verifier.** `tests/terminalProcess.test.js` does not exist at its `verifierCommit`.

The scorecard lists the tasks it could not score. v7 replaces v6 as the active suite.

### Regressions in the historical fixes themselves

In the oracle run of v7, two historical fixes broke an existing test that a later commit repaired: read-file-line-ranges and projection-large-result-budget. The reference fix therefore scores 28/30 regression-free, and an agent can do better than it.

Tests that a fix deliberately rewrote are not counted as regressions. For example, checkpoint-credentials changes what a rewind lists.

### Reference agents and comparisons

```bash
# The oracle applies the historical fix itself: every valid task must pass with it, so a failure
# is a broken task or verifier, not a weak agent. No model, no key.
npm run eval:coding -- --agent oracle

# Claude Code, headless, on the same tasks (needs the claude CLI and its credentials). It runs
# with every permission granted (--dangerously-skip-permissions), in a throwaway worktree.
npm run eval:coding -- --agent claude-code --model claude-sonnet-5-5 --repetitions 3

# Task by task: which side is better on each task, a sign test, and the scorecards side by side
node scripts/eval/compare.js eval/results/<codico run> eval/results/<claude-code run>
```

The manual **Coding Holdout** workflow runs any of the three agents (`agent` input) and shows the scorecard on the run's summary page. Claude Code there needs the `ANTHROPIC_API_KEY` secret.

## ACCO provider-boundary measurements

When Codico runs with the optional ACCO OpenRouter optimizer enabled, the evaluation
snapshot also records provider-boundary optimization telemetry:

- request attempts and changed requests;
- fail-open events;
- provider JSON input/output characters;
- characters saved;
- cumulative optimization latency.

This telemetry is diagnostic only and never changes agent control flow or verifier
outcomes.

For the 0.2.0 validation, the frozen `stream-resume-overlap` task was run in a
paired ACCO-on / ACCO-off control. Both conditions passed **5/6** repetitions.
The median successful-run provider-token count was **672,686 with ACCO** versus
**1,362,844 without ACCO**. This is evidence for that exact task/model/runtime
combination, not a universal savings percentage.

## Freeze policy

`codico-coding-holdout-v1` through `v6` are burned evidence and stay reproducible. `codico-coding-holdout-v7` is active and frozen.

Any semantic scoring or quality-budget change creates a new suite version. Harness-only diagnostics improvements may land in place when they do not change what constitutes success.
