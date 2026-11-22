# @codico/cli

Standalone, cross-platform Codico coding agent for Node.js 20+. Works on Windows, Linux, and macOS without VS Code.

```sh
npm install -g @codico/cli
codico chat --model ollama/qwen2.5-coder:7b
codico agent "Review this project" --model direct:deepseek/deepseek-flash
```

## The terminal

```
╭──────────────────────────────────────────╮
│ ✻ Codico v0.9.2                          │
│   model   ollama/qwen3:14b               │
│   mode    read-only  /mode to change     │
╰──────────────────────────────────────────╯
❯ what does @src/math.ts export?
  ⎿  attached src/math.ts
● Read(src/math.ts)
  ⎿  Read 40 lines
The module exports `add` and `subtract` …
✓ Done · 4.2s · 1 tool · 1.4k in · 133 out
```

- Answers stream live with Markdown rendering (headings, lists, highlighted code blocks).
- Tool calls show as one line each with a short result; `--verbose` (or `/verbose`) shows full output.
- Approvals show a colored diff and take one keypress: Enter approves, Esc denies, `a` approves for the rest of the session.
- `@path` attaches a file (`@path:10-40` for a range); Tab completes paths, `/commands` and `@agents`.
- `!command` runs a shell command yourself; its output is shared with your next message.
- Ctrl+C interrupts the current turn; twice at the prompt quits. Prompt history persists across sessions.
- `/status`, `/mode read|edits|all`, `/model`, `/cost`, `/diff`, `/compact`, `/init`, `/sessions`, `/resume`.
- `codico doctor` checks Node, your model and provider keys, git and browser support.
- `codico config set model ollama/qwen3:14b` stores defaults in `~/.codico/config.json` (user-level only, so a cloned repository cannot redirect your model or endpoint).
- `codico -c` continues the last session in this folder.
- Colors follow `NO_COLOR` / `FORCE_COLOR`; piped output stays plain.

**Note:** This repository version is not published automatically. Verify the npm package name and availability before publishing.

Run `codico --help` for all flags. File edits and shell commands are read-only by default and need explicit opt-ins and approval. MCP subprocesses and browser automation are separately opt-in. `--yes` bypasses approval prompts: only use it in isolated, trusted environments.

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
