# Codico coding holdout

Codico's coding-quality evidence is measured with a frozen historical-regression suite rather than toy generation prompts.

## Frozen suite v2

`eval/tasks.json` contains **26 tasks** derived from bugs and hardening gaps that existed in earlier Codico commits.

v2 was created after the first EOF smoke trials exposed an invalid v1 verifier: v1 required the exact later error-message wording even though the historical base commit had no recovery classifier consuming that string. Two independent patches emitted the correct `stream_error` behavior but were rejected only for wording. v2 replaces that implementation-string assertion with observable semantics: premature EOF must error, while `[DONE]` and a normal `finish_reason` must not.

The original suite is preserved as `eval/tasks-v1.json`, with its original verifier archived under `eval/verifiers/v1/`, so the burned v1 evidence remains reproducible. Each task records:

- an exact pre-fix Git commit;
- a user-style problem statement;
- a hidden regression-test file and exact test case;
- a bounded maximum number of agent iterations;
- a capability category.

The task prompt never contains the verifier test name.

### Execution protocol

For every task the runner:

1. creates a detached Git worktree at the task's historical pre-fix commit;
2. installs that commit's dependencies;
3. launches the **current Codico extension** in a VS Code Extension Host with the historical checkout as the workspace;
4. lets the real agent loop solve the task with real file and terminal tools;
5. records duration, agent steps, tool calls, files written and provider token usage;
6. captures the agent's diff;
7. **only then** copies the verifier test into the historical checkout;
8. compiles/runs that one verifier test and records pass/fail;
9. removes the temporary worktree.

This means the agent cannot read the regression test it is being scored against.

## Running locally

The runner requires an OpenRouter API key and full Git history:

```bash
git fetch --unshallow  # only needed for shallow clones
export OPENROUTER_API_KEY=...
npm ci
npm run eval:coding -- --model deepseek/deepseek-v4-flash

# reproduce the burned v1 suite explicitly
npm run eval:coding -- --suite eval/tasks-v1.json --model deepseek/deepseek-v4-flash
```

Useful subsets:

```bash
# one category
npm run eval:coding -- --filter security

# a single task
npm run eval:coding -- --filter network-dns-pinning

# inexpensive smoke sample
npm run eval:coding -- --limit 4

# repeated trials for variance
npm run eval:coding -- --filter streaming --repetitions 3
```

Results are written beneath `eval/results/` and are intentionally git-ignored. Each run produces per-task JSON plus `summary.json` and `summary.md`.

## GitHub Actions

The **Coding Holdout** workflow is `workflow_dispatch` only. It never runs on push or pull request and therefore never spends model credits automatically.

Configure the repository secret:

```
OPENROUTER_API_KEY
```

Then choose the model/filter/limit/repetitions from the Actions UI. The results directory is uploaded as an artifact even when some tasks fail.

## Freeze policy

`codico-coding-holdout-v1` is burned evidence and remains archived. `codico-coding-holdout-v2` is the active frozen suite.

Do not improve a score by silently rewriting task prompts, changing base commits, weakening verifiers, or replacing a failing task. Any semantic change to the active holdout creates a new suite version while earlier versions remain reproducible.

Harness-only bug fixes are allowed when they do not change what a task asks or what constitutes success.
