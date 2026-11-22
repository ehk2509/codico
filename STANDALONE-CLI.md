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

## Current scope

The initial standalone agent reuses Codico's existing provider clients, native tool schemas, parser, conversation-history protocol and command runner. It supports reading, listing, searching, editing, writing and executing approved commands. VS Code-only tools (LSP, debugger, browser, background agent teams), persisted threads, richer UI diff approvals, and MCP integration have not yet been ported. This is an incremental runtime extraction, not yet an npm-published standalone package or a complete replacement for the VS Code extension.
