# Codico coding holdout

Codico's coding-quality evidence is measured with a frozen historical-regression suite rather than toy generation prompts.

## Frozen suite v3

`eval/tasks.json` contains **26 tasks** derived from bugs and hardening gaps that existed in earlier Codico commits.

v3 fixes two validity problems discovered while burning v2 evidence:

- `tools-fingerprint-arguments` is now scored by its observable fingerprint behavior rather than requiring one particular exported helper or file layout;
- hidden verifiers are preflighted against the historical source tree **before model invocation**. If a verifier depends on a module that did not exist at that base commit, the task is recorded as `INVALID` and spends no model credits.

The burned v1 and v2 suites remain archived as `eval/tasks-v1.json` and `eval/tasks-v2.json`.

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

`codico-coding-holdout-v1` and `codico-coding-holdout-v2` are burned evidence and stay reproducible. `codico-coding-holdout-v3` is active and frozen.

Any semantic scoring change creates a new suite version. Harness-only fixes may land in place when they do not change what constitutes success.
