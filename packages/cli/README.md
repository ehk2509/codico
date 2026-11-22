# @codico/cli

Standalone, cross-platform Codico coding agent for Node.js 20+. Works on Windows, Linux, and macOS without VS Code.

```sh
npm install -g @codico/cli
codico chat --model ollama/qwen2.5-coder:7b
codico agent "Review this project" --model direct:deepseek/deepseek-flash
```

**Note:** This repository version is not published automatically. Verify the npm package name and availability before publishing.

Run `codico --help` for all flags. File edits and shell commands are read-only by default and need explicit opt-ins and approval. MCP subprocesses and browser automation are separately opt-in. `--yes` bypasses approval prompts: only use it in isolated, trusted environments.

Project instructions: `AGENTS.md`, `.codico/instructions.md`. Custom agents and skills: `.codico/agents/*.md`, `.codico/skills/<name>/SKILL.md`. MCP config: `.mcp.json`, with `--allow-mcp` required. Browser needs installed Chromium (and optionally `--browser-path`). Sessions are saved privately under `~/.codico/sessions`, with `--resume last` to continue.

## Node.js API

```js
const { StandaloneAgent } = require('@codico/cli');
const agent = new StandaloneAgent({ cwd: process.cwd(), model: 'ollama/qwen2.5-coder:7b' });
const answer = await agent.run('Review the current project');
console.log(answer);
```

This package is the portable CLI/runtime; the VS Code extension remains in the root of the monorepo.
