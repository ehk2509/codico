# @codico/cli

Standalone, cross-platform Codico coding agent for Node.js 20+. Works on Windows, Linux, and macOS without VS Code.

```sh
npm install -g @codico/cli
codico                                   # interactive terminal in the current folder
codico agent "Review this project"       # one-shot task
codico doctor                            # check your setup
```

## The terminal

```
╭───────────────────────────────────────────────────────────────────────╮
│ ✻ Codico v0.9.2                                                       │
│                                                                       │
│   model  qwen3:14b  (on this computer)                                │
│   mode   Agent — edits files and runs commands, asks before each one  │
╰───────────────────────────────────────────────────────────────────────╯
agent ❯ what does @src/math.ts export?
  ⎿  attached src/math.ts
● Read(src/math.ts)
  ⎿  Read 40 lines
The module exports `add` and `subtract` …
✓ Done · 4.2s · 1 tool · 1.4k in · 133 out
```

- **Modes**, chosen before each session, with Shift+Tab or `/mode`: **Ask** (answers, changes nothing), **Plan** (read-only plan, then "Carry out this plan?"), **Agent** (edits and runs commands, asks first) and **Auto** (no approvals). `--ask`, `--plan` and `--auto` start in a mode.
- **Approvals** show a colored diff and take one key: Enter approves, Esc denies, `a` approves for the rest of the session.
- **Models:** if the model can't be used, Codico lists the ones this computer can use (Ollama or any local OpenAI-compatible server, Claude Code / Codex logins, providers with API keys); `/model` opens the same list.
- **Errors** are explained in plain words with a next step; running out of steps offers "Keep going".
- Answers stream with Markdown rendering; each tool call is one line (`--verbose` or `/verbose` for full output).
- `@path` attaches a file (`@path:10-40` for a range); Tab completes paths, `/commands` and `@agents`; `/` opens the command menu.
- `!command` runs a shell command yourself; its output is shared with your next message.
- Ctrl+C interrupts the turn; twice at the prompt (or `exit`) quits. Prompt history persists across sessions.
- `/status`, `/cost`, `/diff`, `/compact`, `/init`, `/sessions`, `/resume`; `codico -c` continues the last session.
- `codico config set model ollama/qwen3:14b` stores defaults in `~/.codico/config.json` (user-level only, so a cloned repository cannot redirect your model or endpoint).
- Colors follow `NO_COLOR` / `FORCE_COLOR`; piped output stays plain.

See the [standalone CLI guide](../../STANDALONE-CLI.md) for models, modes, commands and security.

**Note:** This repository version is not published automatically. Verify the npm package name and availability before publishing.

Run `codico --help` for all flags. In Ask and Plan, Codico cannot change files or run commands; in Agent every change needs approval; Auto and `--yes` skip approvals, so use them only in folders and environments you trust. MCP subprocesses and browser automation are separately opt-in.

Project instructions: `AGENTS.md`, `.codico/instructions.md`. Custom agents and skills: `.codico/agents/*.md`, `.codico/skills/<name>/SKILL.md`. MCP config: `.mcp.json`, with `--allow-mcp` required. Browser needs installed Chromium (and optionally `--browser-path`). Sessions are saved privately under `~/.codico/sessions`, with `--resume last` to continue.

## Node.js API

```js
const { createCodicoAgent } = require('@codico/cli');
const agent = createCodicoAgent({ cwd: process.cwd(), model: 'ollama/qwen2.5-coder:7b' });
const answer = await agent.run('Review the current project');
console.log(answer);
```

This package is the portable CLI/runtime; the VS Code extension remains in the root of the monorepo.

External web tools are opt-in using `--allow-web`; for Brave Search set `BRAVE_SEARCH_API_KEY`, otherwise Codico uses DuckDuckGo. HTTP fetches reject private, local and metadata endpoints and revalidate redirects. `lsp_symbol` currently uses lexical search rather than an IDE LSP server.

Browser requests are restricted to public HTTP(S) hosts by default; `--browser-local` additionally allows local/private network access, with per-navigation approval.

The SDK supports `agent.run(prompt)` and `for await (const event of agent.runStream(prompt))` for tool/event streaming; `delta` events carry the reply text as it streams. An AbortSignal can stop each request (the run then rejects with "Agent stopped"). `TranscriptRenderer` renders the same events the way the CLI does.

Delegated subagents are read-only and cannot use MCP, browser, or web tools from the parent. Browser URL credentials are rejected even with `--browser-local`.
