# Codico coding holdout

Codico's coding-quality evidence is measured with a frozen historical-regression suite rather than toy generation prompts.

## Frozen suite v4

`eval/tasks.json` contains **26 tasks** derived from historical Codico bugs and hardening gaps.

v4 preserves the v3 task corpus while correcting two evidence-quality issues exposed by live runs:

- the resume-overlap task is scored by overlap behavior and integration use, not by requiring a helper with one exact name;
- the wall-clock limit is a **15-minute safety ceiling** while the quality budgets remain fixed at 16 normal iterations and 400k cumulative tokens. The evaluation host writes periodic partial checkpoints so a hard timeout still preserves steps, tokens, tool calls, and trace evidence.

Burned v1, v2, and v3 suites remain archived as `eval/tasks-v1.json`, `eval/tasks-v2.json`, and `eval/tasks-v3.json`.

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

This keeps hidden tests invisible to the agent, prevents broken historical verifiers from wasting credits, and prevents one timed-out VS Code instance from poisoning the next task.

## Running locally

```bash
git fetch --unshallow  # if needed
export OPENROUTER_API_KEY=...
npm ci
npm run eval:coding -- --model deepseek/deepseek-v4-flash

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

## Freeze policy

`codico-coding-holdout-v1`, `v2`, and `v3` are burned evidence and stay reproducible. `codico-coding-holdout-v4` is active and frozen.

Any semantic scoring or quality-budget change creates a new suite version. Harness-only diagnostics improvements may land in place when they do not change what constitutes success.
