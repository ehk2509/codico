# Codico standalone CLI (Windows / macOS / Linux)

Codico's native CLI runs directly in **Node.js 20+**; it does **not** start VS Code, Electron, or a Linux display server. The original `codico run` and `codico automate` commands still use the editor-backed headless system and are unchanged.

## Install and start

```sh
npm ci
npm run compile
npm link          # makes the `codico` command available
codico            # opens the interactive terminal in the current folder
```

On Windows PowerShell with script execution disabled (the default), `codico` may fail with "running scripts is disabled": delete `%APPDATA%\npm\codico.ps1` so PowerShell uses `codico.cmd` instead, or run `node bin/codico.js` directly.

`codico doctor` checks Node, the selected model, provider keys, git and browser support, and says how to fix what is missing.

## Models

| Model ID | Where it runs | Needs |
| --- | --- | --- |
| `ollama/<name>` | Ollama at `http://localhost:11434` | the model pulled (`ollama pull <name>`) |
| `ollama/<name>` + `--ollama-url <url>` | any local OpenAI-compatible server (llama.cpp, LM Studio, vLLM, Strata…) | the server running; Codico calls `<url>/v1/chat/completions` and lists models from `/v1/models` |
| `direct:<provider>/<model>` | Anthropic, OpenAI, Google, Groq, DeepSeek, Mistral, xAI, Cerebras | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY` or `CEREBRAS_API_KEY` |
| OpenRouter ID (e.g. `anthropic/claude-sonnet-4.5`) | OpenRouter | `OPENROUTER_API_KEY` |
| `claude-code/<sonnet\|opus\|haiku>`, `chatgpt/<model>` | your Claude Code or Codex login | the `claude` or `codex` command installed |

Save a default so a plain `codico` uses it:

```sh
codico config set model ollama/qwen3:14b
codico config set ollamaUrl http://127.0.0.1:8092   # only for a non-default local server
```

Precedence: `--model` / `--ollama-url` flags, then `CODICO_MODEL`, then `~/.codico/config.json`. The config file is user-level only on purpose: a file in a repository could otherwise send your code to a model or endpoint of the repository's choosing.

If the selected model cannot be used when a chat starts (not pulled, server not running, key missing), Codico says why in plain words, lists the models this computer can use and saves your pick. If a turn later fails because of the model, it offers another model and retries the request.

## Modes

Before each chat session Codico asks how it should work in the folder; the folder's last choice is pre-selected, so Enter keeps it. Shift+Tab cycles the modes at the prompt (**Ask → Plan → Agent → Auto**), `/mode` opens the menu, and the current mode is shown before the prompt (`agent ❯`).

| Mode | What Codico does |
| --- | --- |
| **Ask** (`--ask`) | Reads and searches your code and answers questions. Cannot change files or run commands. |
| **Plan** (`--plan`) | Read-only, enforced whatever mode you came from. Writes a numbered plan naming the files affected, then asks **"Carry out this plan?"**: *Yes, with Agent*, *Yes, with Auto*, or *keep planning*, in which case your next message revises the plan. `/plan <task>` does the same from any mode. |
| **Agent** | Edits files and runs commands, asking before each one. |
| **Auto** (`--auto`) | Agent without approvals. A warning is shown when it is turned on; use it only in folders you trust. |

Flags skip the startup question. `--allow-edits` (edit files, no commands) and `--allow-commands` remain available, mainly for scripts. Folder choices are kept in `~/.codico/workspaces.json`.

## Using the terminal

Answers stream live with Markdown rendering. Each tool call is one line with a short result:

```
● Write(index.html)
  ⎿  Wrote index.html (6265 bytes)
● Bash(npm test)
  ⎿  Exited with code 1
     ✖ todos survive a restart
✓ Done · 18.4s · 7 tools · 10.8k in · 1.3k out
```

**Approvals** show the change as a colored diff and take one key: **Enter** (or `y`) approves, **Esc** (or `n`) denies, `a` approves that kind of action for the rest of the session. Only keys pressed after the approval appears count, so text typed while Codico works can never approve anything.

| Input | Effect |
| --- | --- |
| plain text | Ask for what you want: "add tests for utils.ts", "why does the build fail?" |
| `@path/file.ts`, `@path/file.ts:10-40` | Attach a file (read through the same workspace guard as the tools) |
| `!git status` | Run a command yourself; its output is shared with your next message |
| `/` | Open the command menu |
| line ending in `\` | Continue the prompt on the next line |
| Tab | Complete `/commands`, project skills, `@agents` and file paths |
| Shift+Tab | Switch mode |
| Ctrl+C | Interrupt the turn; at an empty prompt, press twice to quit (`exit` also quits) |

When a task needs more than its step budget (50 model requests per turn by default; `--max-steps`, or `codico config set maxSteps`), Codico asks **"Keep going?"**: Enter continues where it stopped, Esc stops.

On Windows, commands run in `cmd.exe`; the model is told so, and output in the console's code page (accented messages from `cmd.exe` and `dir`) is decoded correctly.

### Commands

| Command | Does |
| --- | --- |
| `/model [id]` | Choose the model from a list (or set it by ID); keeps the conversation and saves it as the default |
| `/mode [ask\|plan\|agent\|auto]` | Switch mode |
| `/plan <task>` | Plan read-only, then approve the plan to carry it out |
| `/review <task>` | Review code for bugs and risks |
| `/diff` | Show uncommitted changes and untracked files (git) |
| `/init` | Write an `AGENTS.md` that explains the project to agents (needs Agent) |
| `/new`, `/clear` | Start a new conversation |
| `/sessions`, `/resume [id-prefix\|last]` | List or reopen saved conversations (`codico -c` continues the latest) |
| `/compact` | Summarise the conversation into a new session to free up context |
| `/status`, `/cost` | Model, mode, session and token use |
| `/skills`, `/mcp` | Project agents and skills; connected MCP tools |
| `/verbose` | Show or hide full tool output (also `--verbose`) |
| `/help`, `/exit` | Short help; quit |

### One-shot runs and scripts

```sh
codico agent "Review package.json"
codico agent "Fix the failing tests" --auto
codico agent "Plan the migration to ESM" --plan
codico agent "Summarise src/" --json          # JSONL events
```

When stdout is not a terminal, `codico agent` prints plain text, and `--json` output has no streaming `delta` events. Colors follow `NO_COLOR`, `FORCE_COLOR` and `--no-color`.

`codico config list|get|set|unset` manages `~/.codico/config.json` (`model`, `ollamaUrl`, `maxSteps`, `verbose`); `codico --version` prints the version.

## Permissions and security

In Ask and Plan the model is not given any tool that changes files or runs commands. In Agent, every edit and command needs your approval. In Auto and with `--yes`, approvals are skipped. In CI and other non-interactive runs, modifications are denied unless you combine a permission flag (`--allow-edits`, `--allow-commands`) with `--yes`, or use `--auto`.

In every mode, the standalone host prevents workspace path traversal, denies access to `.git`, `.env*` and other protected locations, honors `.codicoignore` and `.copilotignore` (loaded at session startup), rejects symlink traversal, and truncates tool output. Shell commands still have the operating-system rights of the user running Codico and are **not** fully sandboxed: use Auto and `--yes` only in folders and environments you trust.

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
