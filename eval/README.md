# Codico coding holdout

Codico's coding-quality evidence is measured with a frozen historical-regression suite rather than toy generation prompts.

## Frozen suite v6

`eval/tasks.json` contains **26 tasks** derived from historical Codico bugs and hardening gaps.

v6 preserves the v5 task corpus and behavior-level verifiers, including the requirement that resume-overlap logic is actually called from the recovery path. It changes only the evaluation ceilings:

- **no evaluator wall-clock timeout** (`maxTaskMinutes: 0`);
- **no cumulative token ceiling** (`maxTotalTokens: 0`).

The agent is still bounded by the normal iteration budget plus mutation/verification grace, and hidden verifiers still determine correctness. Periodic checkpoints preserve evidence if the host or CI process is interrupted externally.

Burned v1-v5 suites remain archived as `eval/tasks-v1.json` through `eval/tasks-v5.json`. v5 retains its original 15-minute / 400k-token policy for reproducibility.

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

## Freeze policy

`codico-coding-holdout-v1` through `v5` are burned evidence and stay reproducible. `codico-coding-holdout-v6` is active and frozen.

Any semantic scoring or quality-budget change creates a new suite version. Harness-only diagnostics improvements may land in place when they do not change what constitutes success.
