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

v7 has **no step limit** (`maxIterations: 0`, as Codico runs by default), so a run ends when the agent stops. A first run with v6's 16-step limit cut 22 of 30 runs off mid-work (see below). Like v6, it has no evaluator ceilings:

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

### First v7 run (2026-10-15, still with v6's 16-step limit): Codico with DeepSeek V4 Flash

The run was split into ten workflow runs of 3 tasks each and combined with `node scripts/eval/summarize.js <artifacts>`.

| Measure | Result |
|---|---|
| Task success (pass@1) | **17/30 (56.7%)** |
| Regression-free (verified successes) | 17/17 |
| Edit precision (verified successes) | 17/17 |
| Test passed after the last change | 15/30 |
| Recovery after a failing check | 3/7 |
| Cost per verified success | **$0.14** ($2.46 in total; 1.47M tokens per success) |

**22 of the 30 runs were cut off by the 16-step limit.** Each ended on a step it had just announced, most often the compile or test run of its own change, before reading the result. Those runs count as neither claims of completion nor verified work. Of the 8 runs that did present the task as done, 5 were rejected by the hidden verifier.

### After the fixes (2026-10-16): all 30 tasks pass, each on its latest run

This table takes each task's latest run, and the runs come from several rounds. 17 tasks passed in the first run (with the 16-step limit). 13 passed on reruns: some after Codico was fixed, some after a prompt was corrected to state what its verifier checks. It is not one clean run. A fresh run of all 30 under the final suite and the final Codico gives the clean baseline.

| Measure | Result |
|---|---|
| Tasks passing | 30/30 |
| Regression-free | 29/30. The one flagged, a hooks test, passes 3 out of 3 times with Codico's change applied: it is flaky in CI. The harness now confirms a regression with a second run. |
| Edit precision | 28/30. One run left a stray `tmp/` folder, and one changed two files outside the historical fix. |
| Test passed after the last change | 21/30 |
| Recovery after a failing check | 11/11 |
| Said done when the hidden verifier failed | 0/14 |
| Cost per verified success | $0.14 (1.5M tokens) |

The changes behind it are in Codico, and none of them is specific to a task:
- the step limit never ends a turn between running a check and reading its result;
- before a reply ends, the agent is asked to show the request itself is met: criteria in the request's words, and a failure reproduced on the user's own case;
- the acceptance review runs before the reply ends and reads the agent's tests;
- chained, piped and unknown check results are read correctly.

### Clean run (2026-10-16): 25/30 in one run of the final suite and the final Codico

All 30 tasks ran in parallel, as 15 workflow runs of 2 tasks each, on commit a41ba513, with no step limit and DeepSeek V4 Flash. They were combined with `scripts/eval/summarize.js`.

| Measure | Clean run | First v7 run (16-step limit) |
|---|---|---|
| Task success (pass@1) | **25/30 (83.3%)** | 17/30 (56.7%) |
| Regression-free (verified successes) | 25/25 | 17/17 |
| Test passed after the last change | 28/30 | 15/30 |
| Recovery after a failing check | 21/24 | 3/7 |
| Edit precision (verified successes) | 22/25 | 17/17 |
| False completion | 5 of 29 claims | 5 of 8 |
| Cost per verified success | $0.31 (3.3M tokens) | $0.14 (1.5M tokens) |

The five failures:
- tools-write-nested-fences: the four-backtick workaround again;
- tools-edit-nested-fences: a code block in `new_str` is still cut off;
- tools-fingerprint-arguments: `write_file`'s content is left out of its fingerprint;
- projection-current-reads: `./src/a.ts` and `src/a.ts` are not treated as one file;
- stream-unexpected-eof: a normal finish reason is reported as an interruption.

In four of them the agent's criteria and tests covered its own version of the request, and the reviewer agreed, because the reviewer is not shown the request. Without a step limit, runs are longer and cost per success doubled.

### The same failures with a stronger model (2026-10-16)

The five clean-run failures were rerun one task per run, with the same Codico and the same tasks. On Claude Sonnet 5.5 (`anthropic/claude-sonnet-5.5`):

| Task | DeepSeek V4 Flash | Claude Sonnet 5.5 |
|---|---|---|
| tools-edit-nested-fences | failed (129 steps, 5.0M tokens) | **passed** (20 steps, 0.5M) |
| tools-write-nested-fences | failed 3 of 5 runs | **passed** (17 steps, 0.46M) |
| tools-fingerprint-arguments | passed 2 of 4 (47–59 steps) | **passed** (8 steps, 0.11M) |
| stream-unexpected-eof | passed 2 of 5 (54–145 steps) | **passed** (26 steps, 0.94M) |
| projection-current-reads | failed | failed: its prompt had not named the budget option `maxCurrentReadChars`, which the verifier passes. The prompt now names it. |

Where DeepSeek failed, the stronger model's judgement made the difference. Codico's harness was the same in both runs. `codico.escalationModel` (and the workflow's `escalation_model` input) hands a task to a stronger model when the reviewer disputes it or it stalls. Costs now use the cost the provider reports when there is one, so cache discounts and the escalated model's requests are included.

`scripts/eval/suiteCheck.js` now also checks the option keys the verifiers pass to the functions they call.

### Claude Haiku 5.5 (2026-10-16): 29 of 30 at about $0.04 per solved task

All 30 tasks ran on `anthropic/claude-haiku-5.5` as 15 runs of 2 tasks. Costs are the ones OpenRouter reported, prompt caching included.

- **First pass: 26/30**, $1.07 in total, $0.04 per verified success, about 25 steps per task. Regression-free 26/26, edit precision 25/26, 2 false completions out of 14 claims.
- **The four failures, each rerun on its own:**
  - tools-fingerprint-arguments: passed once its prompt named `toolFingerprint` in `src/toolParser.ts`, which its verifier loads.
  - tools-write-nested-fences: passed once Codico stopped letting an offer or a question end unfinished work. Haiku had asked which fix to make although the request named it.
  - stream-resume-overlap: passed under the corrected v7 verifier (below). Both of Haiku's solutions had been correct.
  - projection-current-reads: still fails. Haiku does not handle the existing "lines … are left out because they are already in this conversation" note. Sonnet 5.5 passed it; DeepSeek V4 Flash passed it in 1 of 3 attempts, in 115 steps and at $0.32.

On these tasks Haiku is about as capable as DeepSeek V4 Flash and several times cheaper per solved task. It uses far fewer steps, and it reports unfinished work more honestly. A cheap default with escalation to Claude Sonnet 5.5 (`codico.escalationModel`) covers the tasks it misses.

### Fewer steps, tried and reverted (2026-10-16)

On five hard tasks with Claude Haiku 5.5, Codico took 169 steps where Claude Code took 92. A set of changes aimed at the extra steps was tried:
- the end-of-turn reminders in one message;
- several criteria verified per call;
- a check not re-run when it had already passed with nothing changed since;
- a hint to batch reads;
- no independent review for small changes whose failure was reproduced and then fixed.

Measured as an A/B comparison, 5 tasks × 3 repetitions on each build, the changed build was **worse**:

| | Before | After |
|---|---|---|
| Passed | 13/15 | 11/15 |
| Median steps per run | 22 | 30 |
| Median tokens per run | 0.72M | 1.26M |
| Cost per solved task | $0.055 | $0.079 |

Median steps were higher on all five tasks. The changes were reverted. A single run per task had not been able to show this: one task's step count varies by 4× between runs.

### Efficiency changes measured one at a time (2026-10-17/18)

Five changes aimed at Codico's extra steps were built and A/B tested one at a time with Claude Haiku 5.5, on the 10 valid mined candidates v7 does not use (`eval/tasks-unused.json`: 8 runnable, × 3 repetitions) and then on the five hard v7 tasks. Together they cut steps by about 30% and tokens by about a third on the 8 tasks. Measured with more runs, though, they lowered the success rate: 20/24 against 24/24 on the 8 tasks, 8/15 against 13/15 on the hard tasks. On one task (tools-write-nested-fences) the baseline passed 21 of 21 runs and the changed build 13 of 21. Bisecting showed that a system-prompt sentence announcing Codico's own check made the agent hand design choices back to the user (7 of 18 runs ended on a question, against 1 of 18), and that the rest of the savings came from checking less. Those changes were not kept.

Kept, because they fix wrong behaviour rather than check less:
- **A test edit no longer asks for a lifecycle re-read.** A test's words (done, finished, error) made its edit look like lifecycle logic, and only a re-read of the test file itself closed the gate: Codico sent the reply back every other step (61 times in 24 runs, 22 in one).
- **A check followed by another command on the line has no known result.** `npm test > log; echo "exit $?"` always exited 0 and counted as a passing check whatever the tests did.
- The benchmark trace records each reminder that sends a reply back, by its kind, and each failed model request.

Measured against the baseline, both builds run at the same time (runs cut short by the provider left out):

| | Baseline | With the kept fixes |
|---|---|---|
| 5 hard tasks × 6: solved | 24/30 | 22/30 |
| Mean steps / tokens per run | 34.5 / 1.27M | 24.2 / 0.83M |
| Cost per solved task | $0.069 | $0.050 |
| 8 tasks × 3: solved | 21/24 | 21/24 |
| Mean steps / tokens per run | 37.1 / 1.44M | 29.3 / 1.10M |
| Cost per solved task | $0.068 | $0.059 |

On the five tasks that failed most, run 6 more times on both builds, they solved 35/51 and 30/51 (12 runs a task, all rounds), a difference within noise, in both directions per task.

Two rounds were lost to the OpenRouter account running out of credits: runs ended at step 1 with 0 tokens and nothing said why. The runner now prints such errors.

### A verifier corrected in v7: stream-resume-overlap

v6's verifier for stream-resume-overlap followed only *exported* functions written `export function name(`. It rejected two valid solutions from Claude Haiku 5.5, which applied the overlap calculation on the resume path through a generator (`export async function* trimResumedContent`) and an internal helper. v7 uses a corrected copy, `eval/verifiers/streamResumeOverlapIntegrated.v7.verifier.js`, which follows every function of the module, generators included. The archived v6 suite keeps the original. The corrected copy was checked from every side:

- the historical fix passes;
- no change fails;
- both Haiku solutions pass;
- both Haiku solutions **fail** once their `agentProvider.ts` wiring is removed.

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
