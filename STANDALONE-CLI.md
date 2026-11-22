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

In the interactive terminal, `/help`, `/model <id>`, `/clear`, and `/exit` are available. Each new terminal session starts with an empty conversation; persistent resume is future work.

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
