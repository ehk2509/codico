# Codico standalone CLI (Windows / macOS / Linux)

Codico's new native CLI runs directly in **Node.js 20+**; it does **not** start VS Code, Electron, or a Linux display server. The original `codico run` and `codico automate` commands still use the existing editor-backed headless system and are not changed by this first migration.

## Develop locally

```sh
npm ci
npm run compile
node bin/codico.js chat --model ollama/qwen2.5-coder:7b
```

Or link the repository's command locally:

```sh
npm link
codico
```

Select an installed Ollama model with `--model ollama/<model-name>`; Ollama defaults to `http://localhost:11434`. Direct providers use `--model direct:provider/model` plus an environment key such as `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`. OpenRouter uses an OpenRouter model ID plus `OPENROUTER_API_KEY`.

Examples:

```sh
codico                         # interactive, read-only by default
codico chat --model ollama/qwen2.5-coder:7b
codico agent "Review package.json" --model direct:deepseek/deepseek-flash
codico agent "Fix tests" --allow-commands --model ollama/qwen2.5-coder:7b
```

### The interactive terminal

**Modes.** Before each session Codico asks how it should work in the folder (the last choice is pre-selected);
Shift+Tab cycles the modes at the prompt and `/mode` opens the menu.

| Mode | What Codico does |
| --- | --- |
| Ask (`--ask`) | Reads and searches, answers questions. Cannot change files or run commands. |
| Plan (`--plan`) | Read-only (enforced, whatever mode you came from). Writes a numbered plan with the files affected, then asks "Carry out this plan?": Enter runs it with Agent, Auto runs it without approvals, Esc keeps planning and your next message revises the plan. `/plan <task>` does the same from any mode. |
| Agent | Edits files and runs commands; asks before each one (Enter approves, Esc denies). |
| Auto (`--auto`) | Agent without approvals. Use only in folders you trust. |

`--allow-edits` (edit files, no commands) remains available for scripts.

The first chat in a folder checks the selected model. If it cannot be used (not pulled, Ollama not running, key missing),
Codico lists the models this computer can use and saves your pick as the default. It then asks once what Codico may do in
the folder (read only, edit files, or edit files and run commands; each action still needs approval) and remembers it in
`~/.codico/workspaces.json`. `--allow-edits`/`--allow-commands` skip that question. Shift+Tab cycles the mode at the
prompt, `/model` and `/mode` open pickers, and `/` alone opens a command menu. When a turn fails because of the model,
the error is explained in plain words and Codico offers another model and retries the request.

Answers stream live with Markdown rendering; each tool call is one line (`● Update(src/a.ts)`) with a short result
(`⎿ Exited with code 1` plus the last output lines). Approvals show a colored diff and take a single keypress:
Enter (or `y`) approves, Esc (or `n`) denies, `a` approves that kind of action for the rest of the session. Keys typed while the agent works
are kept for your next prompt and can never answer an approval.

| Input | Effect |
| --- | --- |
| `@path/file.ts`, `@path/file.ts:10-40` | Attach a file (read through the same workspace guard as tools) |
| `!git status` | Run a command yourself; its output is shared with your next message |
| line ending in `\` | Continue the prompt on the next line |
| Tab | Complete `/commands`, project skills, `@agents` and file paths |
| Ctrl+C | Interrupt the turn; at an empty prompt, twice to quit |

Commands: `/help`, `/status`, `/model [id]` (keeps the conversation), `/mode read|edits|all`, `/cost`, `/diff`,
`/compact` (summarise the conversation into a new session), `/init` (write `AGENTS.md`), `/sessions`,
`/resume [id-prefix|last]`, `/new`, `/clear`, `/skills`, `/mcp`, `/verbose`, `/plan <task>`, `/review <task>`, `/exit`.

Other commands: `codico doctor` checks Node, the selected model (Ollama reachability and whether it is pulled, provider
keys, Claude Code / Codex CLIs), git and browser support. `codico config list|get|set|unset` manages
`~/.codico/config.json` (`model`, `ollamaUrl`, `maxSteps`, `verbose`). Precedence: flags, then `CODICO_MODEL`, then the
config file. The config is user-level only on purpose: a project file could otherwise send your code to a model or
endpoint of the repository's choosing. `codico -c` continues the latest session; `--verbose` shows full tool output;
colors follow `NO_COLOR`/`FORCE_COLOR`/`--no-color`. When stdout is not a terminal, `codico agent` prints plain text as
before, and `--json` output is unchanged (no `delta` events).

## Permissions and security

Codico can read files by default. `--allow-edits` permits proposed writes and `--allow-commands` permits writes and shell commands, but **each action still requires an interactive confirmation**. In CI/non-interactive environments, modifications are denied unless you explicitly combine one of these permission flags with `--yes`.

The standalone host prevents workspace path traversal, denies access to `.git`, `.env*`, and other protected locations, honors `.codicoignore` and `.copilotignore` (loaded at session startup), rejects symlink traversal, and truncates tool output. Shell commands still have the operating-system rights of the user running Codico, and are **not** fully sandboxed: only enable commands when you trust the task and review requests carefully. `--yes` bypasses per-action prompts and should be used only in isolated environments.

## Cross-platform tests

CI already runs the main Node.js suite on `ubuntu-latest`, `windows-latest` and `macos-latest`; the standalone tests are added to that suite. No platform-specific shell scripts are needed for installation or invocation. Terminal commands are launched with Codico's existing `terminalProcess` implementation, which uses the appropriate Windows or POSIX shell.

## Additional standalone capabilities

The current implementation includes workspace-scoped persistent sessions (`--resume last`, `/sessions`, `/resume`, `/new`),
project instructions (`AGENTS.md`, `.codico/instructions.md`), project agents and skills,
approval-gated MCP servers (`--allow-mcp`), approval-gated external web fetch and search (`--allow-web`),
Playwright browser tools (`--allow-browser`), project memory (`remember`), read-only delegated subagents,
lexical symbol search, local TypeScript diagnostics, and authenticated Claude Code / Codex provider modes.

The npm-packaged `@codico/cli` under `packages/cli` provides an independent `codico` executable and Node.js SDK.
Build a local tarball with `npm run package:cli`; publishing to the npm registry requires a separate release.
The packaged CLI also accepts `codico run` as a standalone one-shot alias; the repository's original
`codico run` and `codico automate` remain editor-backed for backward compatibility.

CLI sessions persist to `~/.codico/sessions` in workspace-specific private directories. Use `--no-session`
to opt out. External tools and MCP subprocesses execute with the current user's operating-system rights.
All potentially mutating actions require an explicit opt-in and approval, except that `--yes` bypasses
individual approvals for enabled tools; do not use it on untrusted workspaces or hosts.

**Remaining gaps:** The standalone CLI does not replicate VS Code's interactive debugger, full LSP
references/hover, visual screenshot interpretation, parallel Git worktree teams, or the existing
editor-backed automation watcher. The CLI's `lsp_symbol` uses lexical fallback rather than a language
server. Therefore, this is not complete VS Code feature parity.

For browser automation, private-network and localhost navigation are disabled by default. Pass `--allow-browser --browser-local` only for trusted local development servers; browser interactions still require approval.
