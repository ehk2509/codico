<p align="center">
  <img src="https://raw.githubusercontent.com/ehk2509/codico/main/media/logo-128.png" width="128" alt="Codico logo" />
</p>

<h1 align="center">Codico</h1>

<p align="center"><strong>Your autonomous AI coding agent inside VS Code.</strong></p>

An autonomous coding agent embedded directly in VS Code. Connect directly to major providers with your own keys — Anthropic, OpenAI, Google, Groq, DeepSeek, Mistral, Grok, and Cerebras — access many additional providers through **OpenRouter**, or run fully offline with **Ollama**.

The agent reasons through problems, reads and writes files, runs terminal commands, searches code, applies targeted edits, and iterates autonomously — all from a sidebar chat panel.

---

## Providers

### Direct Provider Connections
Call AI providers directly with your own API keys — no OpenRouter account required:

| Provider | Models | Key command |
|---|---|---|
| **Anthropic** | Claude Opus 4.5, Sonnet 4.5, Haiku 4.5, Claude 3.5 Sonnet | `Codico: Set Direct Provider API Key` |
| **OpenAI** | GPT-6.1 Sol, GPT-6 Sol, GPT-6 Astra, GPT-6 Luna, GPT-5.5, GPT-5.4 Mini | `Codico: Set Direct Provider API Key` |
| **Google** | Gemini 3.8 Flash, Gemini 3.5 Flash, Gemini 3.5 Flash Lite, Gemini 3.1 Pro, Gemini 2.5 Pro, Gemini 2.5 Flash | `Codico: Set Direct Provider API Key` |
| **Groq** | Llama 3.3 70B, Llama 3.1 8B Instant, DeepSeek R1 70B | `Codico: Set Direct Provider API Key` |
| **DeepSeek** | DeepSeek V4.1 Flash, DeepSeek V4 Pro | `Codico: Set Direct Provider API Key` |
| **Mistral** | Mistral Large, Codestral, Mistral Small | `Codico: Set Direct Provider API Key` |
| **Grok (xAI)** | Grok 3, Grok 3 Mini | `Codico: Set Direct Provider API Key` |
| **Cerebras** | Llama 4 Scout 17B, Llama 3.1 70B | `Codico: Set Direct Provider API Key` |

Direct models appear in the model picker under a 🔑 section. Each provider stores its key independently in VS Code's encrypted `SecretStorage`.

### Claude Code (your Claude login)
Use the Claude models of your Claude plan with no API key: Codico runs your installed `claude` command for each request. Pick **Claude Code** in the chat header's provider menu, then Sonnet, Opus, Haiku or Fable.

- Requires Claude Code to be installed and signed in (run `claude` once in a terminal). Installing the Claude Code VS Code extension is enough; `codico.claudeCodePath` points to the command if it is elsewhere.
- Claude Code's own tools, skills and MCP servers are switched off for these requests: Codico's tools, approvals and file protections apply, as with every other provider.
- Usage counts against your Claude plan's limits. Each request sends the conversation so far, so only the system prompt is served from cache.
- Text only for now: attached images are not sent, 

### ChatGPT (your ChatGPT login)
Use the GPT models of your ChatGPT plan with no API key: Codico runs OpenAI's `codex` command for each request. Pick **ChatGPT** in the chat header's provider menu, then a model.

- Requires the Codex CLI, signed in with ChatGPT: `npm install -g @openai/codex`, then `codex login`. `codico.codexPath` points to the command if it is not on the PATH.
- Codex runs read-only with its shell, web search, plugins and other tools switched off, and without your Codex settings: Codico's tools, approvals and file protections apply, as with every other provider.
- Codex prints a reply when it is complete, so the text appears in one piece rather than word by word. Which models you can use depends on your ChatGPT plan.
- Text only for now: attached images are not sent, and inline completions and the other editor features still need an OpenRouter or Ollama model.
- An `OPENAI_API_KEY` in the environment is not passed on, so requests are not billed to an API key by accident. To use an API key, pick the **OpenAI** provider instead.

> Gemini has no login-based provider: Google's Gemini CLI no longer accepts a personal Google login ("migrate to Antigravity"), so Gemini runs with an API key through the **Google** provider or through OpenRouter.
and inline completions and the other editor features still need an OpenRouter or Ollama model.

### OpenRouter
Access hundreds of models through a single API key — including free-tier models from Qwen, Google, NVIDIA, Poolside, Cohere, and more. Set your key via `Codico: Set OpenRouter API Key` or the ⚙ settings menu.

### Local Models (Ollama)
Run entirely offline. Prefix any model ID with `ollama/` — e.g. `ollama/qwen2.5-coder:7b`. No API key required.

### ACCO context optimization (optional)

Codico can send its **provider-facing request copy** through a local
[ACCO — AI Coding Context Optimizer](https://github.com/ehk2509/ai-coding-context-optimizer)
service before the request reaches the provider. This applies to OpenRouter and to
the direct providers (your own key: Anthropic, OpenAI, Google, DeepSeek, Groq, Mistral,
Grok, Cerebras). Codico keeps the canonical chat
history, agent loop, file mutations, and verification state unchanged.

```bash
python -m pip install --upgrade acco
cd /path/to/your/project
acco sdk-serve .
```

Then enable **`codico.accoEnabled`** in VS Code. The default service URL is
`http://127.0.0.1:8770` and can be changed with `codico.accoBaseUrl`.
`codico.accoTimeoutMs` controls how long Codico waits for local optimization.

The integration is deliberately fail-open: if ACCO is unavailable, times out, or
declines a transform, Codico sends the original request unchanged. Non-loopback
ACCO URLs are rejected. Ollama, Claude Code and ChatGPT requests are not optimized:
ACCO has no request shape for them. ACCO works on tool results and tool definitions,
so it changes little when a model falls back to Codico's text tool format.

A paired frozen holdout on the `stream-resume-overlap` task kept the same success
rate with ACCO enabled and disabled (**5/6 in both conditions**), while median
successful-run provider tokens dropped from **1,362,844** to **672,686** in that
experiment. Treat this as task-specific evidence rather than a universal savings
claim; the integration also reports attempts, changed requests, fail-open counts,
provider JSON input/output characters, characters saved, and optimization latency.

---

## Features

### Agentic Loop
After each response the agent executes any tool calls, feeds the results back to the model, and keeps working until the task is complete — without requiring follow-up from you.

- **No step limit by default** (`codico.maxIterations`, `0` = unlimited). The status bar shows the current step.
- **Token and cost tracking** — the status bar shows the last request's tokens (and the share served from the provider's prompt cache) plus the running total for the current task. With OpenRouter it also shows the task's actual cost as reported by OpenRouter; other providers report tokens only. Each thread keeps its total tokens and cost.
- **Progress header** — a task that runs more than a moment shows what it is doing ("Editing… src/app.ts"), the elapsed time, the plan step and the task's tokens and cost.
- **Token budget** — set `codico.taskTokenBudget` (default `0` = off) to pause with **▶ Continue** / **Stop here** each time a task uses that many more tokens.
- **Loop detection** — a tool call repeated with identical arguments more than 3 times *while nothing has changed* is blocked and the model is told to try a different approach. Re-reading a file after editing it, or re-running the tests after a fix, is normal work and is not counted. After three iterations in a row in which none of the model's tool calls could run, the task stops.
- **Automatic recovery** — if a response is cut off (output-token limit or dropped connection), or the provider stops sending for `codico.streamStallTimeoutSeconds` (default 300 s), the agent resumes in the same message: half-written tool calls are re-issued, repeated text is trimmed, and up to 5 retries are made with backoff. The status bar shows *Reconnecting…* meanwhile.
- **Stalled turns** — if the model announces an action ("I'll read the file…") but emits no tool call, or forgets to close its last tool call, the agent recovers instead of stopping.
- **Native tool calling** — OpenRouter and supported direct providers use their structured function/tool API by default. Fenced tool blocks remain available as a compatibility fallback (and are still used for Ollama). Set `codico.nativeToolCalling=false` to force compatibility mode.

### Live Thinking Visualization
For reasoning models (DeepSeek R1, Qwen3, etc.) the agent's internal chain-of-thought is shown in a collapsible "Reasoning trace" panel above each response, streamed in real time. Hide these blocks with `codico.showReasoning`.

---

### Token Efficiency
Long agent tasks resend the conversation with every step, so Codico keeps what is resent small and cacheable:

- **Prompt caching** — requests to Claude models (direct and through OpenRouter) ask the provider to cache the conversation; OpenAI, DeepSeek, Gemini, Grok and Moonshot cache automatically. The system prompt and tool list stay identical for the whole task (phase guidance is added to the conversation instead), so cached reads keep matching. Replaying a recorded 63-request task, this cut billed input by an estimated 85% at Claude cache pricing.
- **Plan approval** — approving a plan drops the planning turn's file reads from the context; the plan itself stays and the agent re-reads what it needs.
- **Trimmed history** — older large tool results are shortened, and a result repeated unchanged (a file read twice) is sent only once. A file read is the exception: it stays as long as the file has not been edited since and no later read holds the same lines, because replacing it with a note only makes the agent read the file again. The reads kept this way are bounded in total size.
- **Usage record** — each reply stores what its task cost request by request (prompt, completion and cached tokens, and whether a subagent made the request) and when the conversation was compacted. The token display's tooltip shows the number of requests of the task.
- **Lean additions** — the context block names the other open tabs instead of including their contents; a search returns at most 40 matches, 6 per file, with an exact count of what was left out and in which files; and a reminder Codico attaches to tool results is given in full once, then as one short line while it still applies.
- **No repeated reads** — a `read_file` does not send lines the model already has. Codico looks in the conversation itself for earlier text of that file (reads, and the snippets edits return): a range that is all there and unchanged gets a one-line pointer instead of the text, and an overlapping range gets only its new lines. A line that changed, by the agent, by a command or by you, is always sent; so is everything after a compaction or a rewind, since the earlier text is then gone. Asking a second time for exactly the lines that were declined returns them.
- **Compaction** — see *Context Compaction* below.

---

### Built-in Tools

| Tool | Description |
|---|---|
| `read_file` | Read any file in the workspace |
| `list_directory` | List the contents of a directory |
| `write_file` | Create or fully overwrite a file |
| `edit_file` | Apply a precise string replacement (unique match required) |
| `search_files` | Search across workspace files by text or regex |
| `find_files` | Locate files by name/glob pattern |
| `run_terminal` | Execute a shell command — output streams live in the chat |
| `get_diagnostics` | Fetch TypeScript/ESLint/etc. errors from VS Code |
| `fetch_url` | Fetch readable text from a public HTTP(S) URL (private/loopback destinations are blocked) |
| `lsp_symbol` | Look up symbol definitions/references via the language server |
| `browser_*` | Full browser automation (navigate, click, type, screenshot, get text) via Playwright |
| `mcp_call` | Call any tool exposed by a connected MCP server |
| `update_todo` | Declare and live-update a task checklist visible in the chat |
| `debug_get_variables` | Inspect local variables from the active debug session |
| `debug_get_callstack` | Read full call stack across all threads |
| `debug_list_breakpoints` | List all breakpoints with location, condition, and enabled state |

Every tool that modifies files or runs code shows a **permission card** — **Allow**, **Allow all writes / commands this task**, **Edit** (for writes) or **Deny**. Permissions reset with each new message; after the agent has read web or MCP content, commands are asked about again even when allowed for the task.

Your own changes are never silently overwritten: if you edit a file while its approval card is open, an edit is re-applied to the current content (and a whole-file write is not made); files open with unsaved changes are read from and written through the editor; Undo, Redo and accepting an Edits-mode proposal ask before overwriting a file that changed since.

File content passed to `write_file` / `edit_file` may itself contain Markdown code fences (for example a README), as long as each inner fence names a language (`` ```bash ``); the agent may also open the tool call with four backticks.

---

### Local Model Support (Ollama)
Run the agent entirely offline with any Ollama model:

- Prefix any model ID with `ollama/` — e.g. `ollama/qwen2.5-coder:7b`
- Streaming, inline completions, auto-commit message generation, and all tools work identically
- Preconfigured in the model dropdown: Qwen2.5 Coder, Qwen3, DeepSeek R1/Coder, CodeLlama, Llama 3, Mistral, Gemma 3
- Set the server URL with **Codico: Set Ollama Base URL** (default: `http://localhost:11434`)

---

### Live Terminal Output
When the agent runs a shell command, output streams directly into the chat panel in real time — no waiting for the process to finish:

- A dark **terminal block** appears below the step pill with the command label and a live ● Running indicator
- Output scrolls automatically as new lines arrive; scroll up to pause auto-scroll
- On completion the indicator changes to ✓ Done (green) or ✗ Failed (red)
- Successful runs auto-collapse after 2 seconds; click the header to expand/collapse at any time
- Commands are killed after `codico.terminalTimeoutSeconds` (default 300 s), together with every process they started; **■ Stop** does the same immediately
- Commands get no input, so one that prompts (an `npx` install, `npm init`) fails at once instead of waiting for the timeout
- The model sees the start and, mostly, the end of long output — where test failures and summaries are
- A command that leaves a process running in the background (e.g. `nohup npm start &`) no longer blocks the agent. The status bar shows a **⚙ N background processes ✕** chip — hover to see the commands, click to stop them. They are also stopped when VS Code closes.
- **Stop** ends the reply and kills the command that is running, with everything it started. Background processes left by earlier commands are not killed: you may still want the dev server. If any are running when you press Stop, the reply ends with a note naming them and a **Stop them** button.

---

### Live Task List (Todo Tracker)
The agent can declare and update a live task checklist using the `update_todo` tool:

```
- [ ] Explore codebase
- [~] Add feature X        ← currently active (pulsing)
- [x] Write tests          ← done (strikethrough)
- [!] Fix CI pipeline      ← failed
```

- A collapsible card appears in the chat with a progress bar and `done / total` count
- Updates live as each step completes — auto-expands when a task becomes active, auto-collapses when all tasks finish
- The `/plan` execution tracker uses the same widget

---

### Inline Diff View (File Changes)
Every file write and edit shows a colored diff before and after the change:

- **Permission cards** show a `+N −M lines changed` diff preview before you approve
- **Result pills** show the same diff after acceptance so you can review what changed
- Green `+` / red `−` lines with context and `@@` hunk separators; long diffs show their first 40 lines with **Show all**
- Click `▶ +N −M lines changed` to expand/collapse
- **Open diff** on a change opens VS Code's diff editor (the file before the change against now), side by side and highlighted

---

### Auto-Commit After Task
A **📥 Auto-commit** toggle in the chat header triggers an automatic `git add -A && git commit` after the agent finishes any turn that wrote files:

- Commit message is AI-generated from the conversation context (works with all providers)
- A status bar flash confirms the commit: `✔ Committed: <message>`
- Toggle per-session in the header row

---

### Proactive Error Detection
When you open a file that has errors in the Problems panel, a banner appears in the chat panel:

> ⚠️ I see 3 errors in `src/foo.ts` — want me to fix them?

- **Fix errors** — injects the active file's diagnostics and sends a fix request immediately
- **✕** — dismiss the banner
- Respects the `codico.proactiveErrorDetection` setting (default: `true`)

---

### Debugger Integration
While a VS Code debug session is active, the agent can inspect program state using three tools:

- **`debug_get_variables`** — reads local/closure variables from the top (or specified) stack frame, organized by scope
- **`debug_get_callstack`** — shows full call stack for all threads with file name and line number
- **`debug_list_breakpoints`** — lists every breakpoint: path, line, condition, hit-condition, enabled state

The tools fail gracefully with a clear message when no debug session is running.

---

### Everyday Conveniences
- **Drafts and reading position** — each thread keeps its own unsent message and remembers where you were reading. Both survive switching threads, hiding the panel and reloading the window. (Attached files and images are not kept with a draft.)
- **Context meter** — next to the token count: how close the conversation is to being compacted, as a bar and a percentage of the auto-compact threshold (green, then yellow from 70%, red from 90%). With auto-compact off it shows the size of the last request instead.
- **Code block actions** — **Insert** puts the code at the cursor of the editor in use (replacing the selection); **New file** opens it in an untitled editor in its language; **Copy** as before. They work while the reply is still being written.
- **Export a thread** — the ⤓ button on a thread in the list saves the conversation as a Markdown file or copies it: your messages, the replies, the steps taken (folded) and each change report. Reasoning and raw terminal output are left out.
- **Message while the agent works** — a message sent during a task is given to the agent at its next step, with the result of the step in progress, so you can correct or add to a task without stopping it; the reply shows where it was taken in. Until then it waits in a banner (and is sent as a normal follow-up if the task finishes first). Commands and messages with attachments wait for the reply to end. **Edit** puts it back in the box to change it, × cancels it, and anything you type while it waits stays in the box after it is sent.

### Search
One search for the conversation that is open and for all of them. Press `Ctrl+F` (`Cmd+F` on macOS) in the chat, or click **🔍** in the thread bar; the switch at the left of the bar chooses **This thread** or **All threads**, and what you typed is kept when you switch.

**This thread**
- Every match is highlighted, in your messages, replies, code blocks and reasoning; the count shows "3 of 17"
- `Enter` / `Shift+Enter` (or ↓ ↑) step through the matches; a match inside a collapsed code block, a folded run of steps or a closed reasoning trace opens it
- Works while a reply is streaming: new matches are counted as the text arrives
- With text selected, `Ctrl+F` searches for the selection

**All threads**
- Live search as you type, in thread names and message content; results show the thread, who wrote the message (▶ you / ◀ Codico) and the text around each match
- Click a result, or `Enter` / `↓` then `Enter`, to open that thread: the bar switches back to **This thread** with its matches highlighted
- `Esc` closes the search

### Notifications
When a reply finishes, or Codico waits for your approval (a file change, a command, a "continue?" pause), and you are not looking at the chat:

- VS Code in the background → a desktop notification (`notify-send` on Linux, Notification Center on macOS, a tray balloon on Windows), plus a notification inside VS Code for when you come back
- VS Code in front but the chat hidden → a notification inside VS Code with a **Show Codico** button
- Nothing while the chat is in view. Turn it off with `"codico.notifications": "off"`. In a remote window (SSH, WSL, containers) only the in-editor notification is used

### Code Search
The agent has a ranked search of the whole repository, `search_code`. It describes what it is looking for in words or identifiers — "where the retry delay is computed", "session token refresh" — and gets back the best-matching definitions with file and line, the symbols each defines, a few of its lines, and the files that import it. One call often replaces a round of trial-and-error text searches.

- **Local and free.** The index is built on your machine the first time the tool is used. No API key, no embeddings, and nothing leaves the machine.
- **Symbol-aware.** Files are cut at function and class boundaries, so a result is a whole definition. The chunk that defines a symbol outranks the ones that mention it. `autoCompactThreshold`, `auto_compact_threshold` and "compact threshold" all find the same code. Definitions are recognised in TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, C#, C/C++, Ruby and PHP; other files are searched as text.
- **Knows who uses what.** The first results list the files that import them: relative and aliased (`@/…`) imports in JavaScript and TypeScript, Python modules, Java and Kotlin classes, Rust modules and Go packages.
- **Code before prose.** Source ranks above tests, and tests above documentation, unless the question asks for tests or docs. The filler words of a question ("how", "when", "too") are not searched for.
- **Uses what else is available.** When a language server is running, its exact symbol list is asked too, so declarations the patterns miss are still found. When you have built the embeddings index (**Codico: Index Workspace**), its matches by meaning are blended in, so a question that shares no word with the code can still find it. Neither is required, and neither is waited for longer than 1.5 seconds.
- **Every folder.** With several workspace folders open, all are searched, and a result is named `folder/path`, the same way the file tools address it.
- **Large repositories.** Up to `codico.codeSearchMaxFiles` files (default 5,000) and about 30 MB of source; files that git ignores, generated or binary files, lock files and files over 200 KB are skipped. On a test tree of 3,365 files (39 MB) the index took 3.4 seconds to build and a query 2 ms.
- **Current.** Changed files are re-indexed before the next search, and the agent's own edits at once.
- **Same protections as reading.** Files excluded by `.codicoignore`, files behind a symbolic link that leads outside the workspace, `.env` files and private keys are never indexed or shown.

This is separate from the optional embeddings index used by `@workspace` (**Codico: Index Workspace**), which sends code to an embeddings API and is limited to 600 files.

### Subagents
For a question that needs a lot of reading before anything can be done — how a feature works end to end, every place something is used, what a change would affect — the agent can **delegate** it. A subagent starts with a conversation of its own, reads and searches as much as the question needs, and returns a short report with file paths and line numbers. Only the report enters the main conversation, which stays small however much was read.

- **Read-only.** A subagent can read, search, list and check diagnostics. It cannot edit, run commands, browse or delegate further; such a call is refused and it carries on.
- **Roles.** With project agents defined (`.codico/agents`), the agent can delegate to one by name — for example a review to your `reviewer` — and the subagent follows that agent's instructions.
- **Visible.** A delegation shows as a step, with the subagent's own reads under it and its requests and tool calls counted. Its tokens count toward the task.
- **Bounded.** A subagent gets `codico.subagentMaxSteps` requests (default 10); out of steps, it is asked once more, without tools, for its report. Stop ends it with the task.
- The agent decides when delegating is worth it; you can also ask for it ("use a subagent to find…"). Works with every provider, in both tool formats.

### Change Report
A reply that changed files ends with a **Change report**: what changed, and what evidence there is that it works.

- **Verdict** — *Verified* (a check passed after the last file change, and none is failing), *Checks failing*, or *Not verified* (nothing was run after the last change). An unverified or failing report says why without being opened.
- **Files changed** — each file with its lines added and removed over the whole turn; click one to see its diff. A file changed after the last passing check is marked "not checked".
- **Checks** — the test, build, type-check and lint commands that ran, with their result. For tests the pass and fail counts are read from the runner's summary (node --test, Jest, Vitest, pytest, Mocha, Cargo, Playwright). A check that failed earlier in the turn and passes now is marked "was failing": the before and after of a fix.
- **Not covered** — stated plainly: no tests run, a check that ran before the last change, a result hidden by a pipe (`npm run build | tail` always exits 0, so it is not counted as a pass).
- **Copy as Markdown** puts the report on the clipboard, for a pull request description.

The report is built from the files Codico wrote and the commands it ran, not from what the model says, and it costs no model request. Turn it off with `"codico.changeReport": false`.

### Project Skills and Agents
A project can teach Codico how it works, with Markdown files in a `.codico` folder that you commit with the code:

```text
.codico/
  agents/reviewer.md             an agent: call it with @reviewer
  skills/add-migration/SKILL.md  a skill: Codico uses it when a task matches, or run it with /add-migration
```

Each file starts with a short header, followed by the instructions:

```markdown
---
name: add-migration
description: Use when adding or changing a database migration
---

1. Read db/schema.sql and the newest file in db/migrations.
2. Name the new file with the next number and a short description.
3. Run `npm run migrate:check` and fix what it reports.
```

- **Skills** are for one kind of task. Codico is told each skill's name, description and path — not its text — and reads the file when a task matches, so a skill you do not use costs one line. `/add-migration add users.email` runs one directly, with its instructions attached to your request. The layout is the same as Claude Code's `SKILL.md`, so one folder of skills can serve both tools; a single file `.codico/skills/<name>.md` works too.
- **Agents** are a way of working you choose yourself: `@reviewer check src/app.ts` puts that agent's instructions at the head of the system prompt for the turn. They appear in the `@` menu next to the built-in agents, marked "project".
- **Create one** with **Codico: New Skill** or **Codico: New Agent**; changes to the files are picked up at once.
- **Rules:** names are lowercase letters, digits and hyphens, and cannot reuse a built-in name (`@workspace`, `/fix`, …); instructions are limited to 20,000 characters; at most 50 of each are loaded. A file that breaks a rule is skipped and you are told which and why.
- **Trust:** these files are instructions to the model, like `.codico-instructions.md`. They are not loaded in a folder VS Code has not been told to trust, and they only add instructions — Codico's approvals for file changes and commands still apply.

### Remembered Commands
The approval card of a terminal command has a second row, **Always allow in this workspace**, with the command itself and, for well-known build and test tools, the command with any arguments:

- `npm test -- --watch=false` offers `npm test -- --watch=false` and `npm test *`; `git status` offers `git status` and `git status *`; `pytest tests/unit` offers `pytest *`.
- Anything else (`rm -rf build`, `node -e "…"`, `python manage.py migrate`, a command with `&&` or a pipe) is offered only as written, and then allowed only when it is exactly that.
- A rule with `*` covers further arguments to that one program and nothing else: `npm test; rm -rf ~`, `npm test && …`, `npm test | …`, `npm test > file` and `npm test $(…)` still ask.
- **Codico: Remembered Commands** lists the rules; untick one to be asked again.
- The rules are per workspace, are not read from any file in the repository, and do not apply once the agent has read web or MCP content in the current turn (the same exception as "Allow all commands this task").

### Lifecycle Hooks
A project can run its own checks around what the agent does. Put them in `.codico/hooks.json` (**Codico: New Hooks File** writes a starting one):

```json
{
  "hooks": [
    { "event": "beforeEdit", "match": "migrations/**", "name": "migration rules", "command": "node scripts/check-migration.js" },
    { "event": "afterEdit", "match": "**/*.ts", "name": "lint", "command": "npx eslint {file}" },
    { "event": "beforeCommand", "match": "git push*", "command": "exit 1" },
    { "event": "afterCommand", "match": "npm test*", "command": "node scripts/coverage-floor.js", "timeoutSeconds": 120 }
  ]
}
```

| Event | Runs | If the hook exits with a code other than 0 |
|---|---|---|
| `beforeEdit` | before `write_file` / `edit_file` changes a file (and before you are asked to approve it) | the edit is refused; the agent is given the hook's output as the reason |
| `afterEdit` | after the change is on disk | the output is added to the edit's result, so the agent sees it and can fix it |
| `beforeCommand` | before `run_terminal` runs a command | the command is refused, with the hook's output |
| `afterCommand` | after the command has finished | the output is added to the command's result |

- **`match`** (optional) narrows a hook: for edits a glob on the file's path in the workspace (`**/*.ts`, `migrations/**`; a pattern without `/` is a file name in any folder), for commands the command line with `*` as the wildcard (`git push*`, `*npm test*`). Without it the hook runs for every edit or command.
- **What a hook is told.** `{file}` in the command is replaced by the quoted file path. The environment has `CODICO_HOOK_EVENT`, `CODICO_HOOK_TOOL`, `CODICO_HOOK_FILE`, `CODICO_HOOK_COMMAND` and, after a command, `CODICO_HOOK_EXIT_CODE`. `CODICO_HOOK_INPUT` is the path of a JSON file with the whole call: the new content or the old and new text of an edit, or the command with its exit code and output.
- **What the agent is told.** Whatever the hook prints, up to 4,000 characters. A hook that passes and prints nothing adds nothing to the conversation.
- **Limits.** A hook runs in the workspace folder with the same reduced environment as the agent's commands, and is stopped after `timeoutSeconds` (default 30, at most 600); a `before` hook that is stopped refuses the call. At most 20 hooks are loaded. The file is read again when it changes, and an entry with a mistake is reported and skipped.
- **Trust.** A hook is a command from the repository, so it never runs in a folder VS Code has not been told to trust, and Codico shows you each command and asks once before running it. Approval is for that exact command in that workspace: a hook that is changed is asked about again. A hook you do not allow is skipped, and the agent's edit or command goes ahead as it would without hooks.

### Getting Started Guide
On first install Codico opens a short guide (provider, first task, staying in control, finding things) — reopen it with **Codico: Get Started**. Until a provider is set up, the empty chat lists the ways to do it: an OpenRouter key, your Claude Code or ChatGPT login (marked when the command is found on your machine), your own provider key, or local Ollama.

---

### Named Chat Threads
Manage multiple independent conversations per project:

- A **thread list** groups sessions into Pinned / Today / Yesterday / This week / Older, with a preview line, pin (📌), rename (✏), duplicate (⧉) and delete (🗑) buttons, and each thread's total tokens and cost on hover
- **Duplicate (⧉)** copies a thread's whole conversation — as the panel shows it and as the model sees it — into a new unpinned thread named "<name> (copy)" and opens it. The original is untouched and the two are fully independent; duplicating is refused while a reply is running
- Click **+** to create a new thread; click 🔍 to search across all threads
- The first message in a new thread auto-names it immediately
- Reopening a thread — or reloading the window — restores the full conversation exactly as it streamed: text, reasoning, tool steps, diffs and terminal output (about 400k characters per reply are stored; threads saved by older versions show short summaries)
- If the window closed while the agent was mid-task, a **Session was interrupted — resume?** banner offers to continue it
- Messages show when they were sent ("2m ago", full date on hover)

---

### Rewinding, Editing, Deleting and Regenerating Messages
Each of your messages has its actions next to its time:

- **↺ Rewind to here** — takes the conversation back to just before that message *and* puts back every file Codico changed since, over as many turns as that covers. A dialog lists the files first and also offers to rewind the conversation only. A file you have edited by hand since is asked about, and kept unless you agree; a file Codico created is deleted again. The message returns to the input box so you can change it and send it again, and **Redo** reapplies the rewound changes one at a time. Not restored: what terminal commands changed on disk, and changes from before VS Code was last restarted (the record of changes is kept in memory, for the newest 300).
- **✎ Edit and resend** (or press `↑` in an empty input to edit your last one) — the conversation is cut back to that message and the edited text is sent. For a Plan-mode message you edit the goal.
- **🗑 Delete** — removes the message and everything after it, after a confirmation.
- **↻ Regenerate** on the latest reply runs its message again and replaces the reply.

The panel, the saved thread and the history the model sees are always cut at the same point. Messages already folded into a compaction summary cannot be changed.
- Threads are persisted to `workspaceState` (per-project) or `globalState` (cross-window) depending on `codico.globalHistory`

---

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+L` / `Cmd+Shift+L` | Focus the chat panel and input box |
| `Ctrl+I` | Inline Chat: edit selected code with AI |
| `Ctrl+Enter` | Accept inline diff |
| `Esc` | Reject inline diff (editor) · stop the reply (chat panel) |
| `↑` (empty chat input) | Edit and resend your last message |
| `Enter` / `Shift+Enter` | Send / new line |

---

### Slash Commands

| Command | Effect |
|---|---|
| `/fix` | Fix bugs in the active file (auto-injects Problems panel diagnostics) |
| `/explain` | Explain the active file or selected code step by step |
| `/doc` | Add JSDoc/TSDoc comments to the active file |
| `/tests` | Write unit tests for the active file or selection |
| `/review` | Structured code review of the active file |
| `/plan` | Create a step-by-step plan for a goal, then approve to execute |
| `/test` | Detect the project's test command, run it, and fix failures until the suite passes |
| `/compact` | Summarize the conversation history to reduce context size |
| `/pr` | Fetch the open GitHub PR for the current branch and review it |
| `/coverage` | Parse the coverage report and generate tests for uncovered lines |
| `/new <description>` | Scaffold a new file or project from a natural-language description |

Type `/` in the input box to see the autocomplete popup.

---

### Extension Commands

| Command | Effect |
|---|---|
| `codico.openChat` | Focus the chat panel (`Ctrl+Shift+L`) |
| `codico.setApiKey` | Set your OpenRouter API key |
| `codico.setDirectApiKey` | Set a direct provider API key (Anthropic, OpenAI, Google, Groq…) |
| `codico.gettingStarted` | Open the Get Started guide |
| `codico.newSkill` | Create a project skill in `.codico/skills` |
| `codico.newAgent` | Create a project agent in `.codico/agents` |
| `codico.newHooks` | Create `.codico/hooks.json` for project hooks |
| `codico.rememberedCommands` | Review and remove the terminal commands always allowed in this workspace |
| `codico.setOllamaUrl` | Set the Ollama server base URL |
| `codico.setGithubToken` | Store a GitHub token for PR context features |
| `codico.toggleInlineCompletions` | Toggle ghost-text inline completions on/off |
| `codico.indexWorkspace` | Build the semantic workspace index (embeddings) |
| `codico.clearWorkspaceIndex` | Clear the semantic workspace index |
| `codico.undoLastChange` | Undo the last AI-applied file change |
| `codico.redoLastChange` | Redo the last undone AI change |
| `codico.generateCommitMessage` | Generate a commit message from the staged diff |
| `codico.showPrContext` | Show the GitHub PR context for the current branch |
| `codico.generateTestsFromCoverage` | Generate tests for uncovered lines in a coverage report |
| `codico.suggestRename` | Suggest a better name for the symbol under the cursor |
| `codico.askAboutDiffHunk` | Ask about a changed file or diff hunk (SCM / editor context menu) |
| `codico.explainTerminalError` | Explain the selected terminal output (terminal context menu) |
| `codico.inlineChat` | Inline Chat: edit the selection with AI (`Ctrl+I`) |
| `codico.acceptInlineDiff` / `codico.rejectInlineDiff` | Accept or discard an inline edit (`Ctrl+Enter` / `Esc`) |
| `codico.codeLensExplain` / `codico.codeLensFix` | Explain or fix a function (used by the CodeLens actions) |

---

### `@` Agent Mentions

| Agent | What it does |
|---|---|
| `@workspace` | Searches the workspace index (semantic + keyword), injects file tree and active file |
| `@terminal` | Injects npm scripts and `git status` — best for shell/build questions |
| `@vscode` | Reads `.vscode/` configs and extension metadata — best for Extension API questions |
| `@github` | Searches GitHub issues, PRs, and repos using your stored token |

Type `@` in the input box to see the autocomplete popup.

---

### Context Injection
Attach live workspace context to any message via the toolbar above the input box:

- **📄 File** — injects the full content of the currently open file
- **📁 Files** — opens a multi-select picker to attach one or more workspace files
- **✂️ Selection** — injects only the selected text (with file path and line range)
- **⚠️ Problems** — injects all current workspace errors and warnings

**Auto selection injection** — when you highlight code in any editor, a `✂ filename:line-range` chip automatically appears in the input area and the selected code is included in the next message context. The chip disappears when you deselect. No click required.

Context chips appear as removable badges before sending, with their size; a chip warns when a file was cut to its first 20,000 characters.

**Drag and drop** — drop files onto the chat to attach them: text files as file context, images as image attachments. From VS Code's Explorer, hold **Shift** while dragging (a VS Code requirement); workspace files excluded by `.codicoignore` are refused.

**Images** — attach screenshots or diagrams with the **📎** button, by pasting, or by drag-and-drop (requires a vision-capable model).

---

### Reading Replies
- **File paths open the file** — `src/app.ts:42` in a reply, or a path in a tool step (Reading / Editing / Written), opens the file at that line
- **Grouped steps** — when a reply finishes, runs of three or more tool steps collapse into one line ("12 steps · read 7 files, searched 3×, ran 2 commands"); failed steps, terminal output and diffs stay visible
- **Long code blocks** start as a preview with an **Expand** button; the header shows the line count
- **Long replies** get an outline of their headings and a **↓ Summary** link
- **Scrolling** — scroll up while a reply streams to read; it stops following, and **↓ Jump to latest** takes you back
- **Density** — `codico.chatDensity` switches between comfortable and compact spacing
- An empty panel offers suggestions to start from, including fixing the errors in the Problems panel

---

### Chat Modes
The toggle under the input box switches how the next message is handled:

- **💬 Ask** — read-only: the agent searches and answers; file writes, edits, terminal commands, browser actions and MCP calls are blocked
- **📋 Plan** — the agent first produces a step-by-step plan, then waits: nothing is changed until you click **▶ Approve & Execute** (same as `/plan`). While planning it can only read and search, enforced like Ask mode, so it can ground the plan in your code without modifying it.
- **🤖 Agent** — fully autonomous with all tools (default)

While a response is streaming, **Send** becomes **Queue →**: your next message is given to the agent at its next step, or sent automatically when the response finishes if there is no next step.

When a request is ambiguous, the agent may ask a **clarifying question** rendered as clickable options (with optional free-text input) before it starts.

---

### Workspace Diagnostics Auto-Injection
When `codico.autoInjectDiagnostics` is enabled (default: `true`), all current Problems panel errors and warnings are automatically prepended to every AI request. A live badge in the header shows the current error/warning count and updates in real time.

---

### Completion Notifications
When the agent finishes a long task while the VS Code window is not focused, a notification pops up:

> Codico finished: "your message…"   [Open Chat]

Configurable via `codico.completionNotificationsEnabled` and `codico.completionNotificationThresholdMs` (minimum task duration before notifying, default 5 s).

---

### CodeLens: Explain / Fix
Two CodeLens actions appear above every function/method definition across all languages:

- **✨ Explain** — sends the function body to the AI for a clear step-by-step explanation
- **🔧 Fix** — sends the function body plus any overlapping diagnostics

Toggle with `codico.codeLensEnabled`.

---

### Inline Chat
- Press `Ctrl+I` or right-click → **Inline Chat: Edit with AI**
- Pick a command: `/fix`, `/doc`, or a custom instruction — these stream a diff directly into the editor buffer with red/green highlighting
- `/explain` and `/tests` route to the sidebar chat
- Press `Ctrl+Enter` to accept the diff or `Esc` to discard
- Needs an OpenRouter model (as do Next Edit Suggestions, Suggest Rename and commit message generation)

---

### Inline Completions (Ghost Text)
As you type, the agent suggests completions inline (grey ghost text). Press `Tab` to accept. Works with OpenRouter and Ollama models; with a direct-provider model selected Codico says it is not supported instead of sending requests. Configure with:

- `codico.inlineCompletionsEnabled` — enable/disable (default: `true`)
- `codico.inlineCompletionsDebounceMs` — delay before triggering (default: `600`)

---

### Edits Mode (Multi-file Diff Review)
Click the **✏ Edits** toggle in the header to enter Edits Mode:

- The agent queues all file changes as proposals rather than writing them immediately
- Each proposal appears as a diff card with **Accept** and **Reject** buttons
- An edit with several separate changes lists them under the file ("Change 2 of 3 · line 14 · +1 −1" with the removed and added lines), each with its own **✓** and **✗**: accepting one writes only that change to the file and leaves the others to decide; rejecting one drops it and touches nothing. A new file is accepted or rejected whole
- Use **Accept All** / **Reject All** for bulk operations
- **Undo / Redo** (↩ ↪) let you reverse any accepted AI change

---

### Context Compaction
Keep long sessions efficient:

- **↓↑ Compact context** button — summarize the conversation history immediately to reduce token usage
- **↙ Auto-compact** toggle (on by default) — automatically compact when prompt tokens exceed `codico.autoCompactThreshold` (default: 60,000 tokens), including between steps of a running task
- Compaction preserves key decisions, files changed, errors resolved, and outstanding tasks; the most recent messages are kept verbatim for continuity
- The chat display is not affected — reopening a thread still shows the full conversation

---

### Follow-up Suggestions
After each response, 3 context-aware follow-up suggestion chips appear below the message. Click one to send it instantly. Toggle with `codico.followUpSuggestionsEnabled`.

---

### Coverage-Based Test Generation
Run **Codico: Generate Tests from Coverage Report** (or `/coverage`):

1. Discovers `lcov.info`, `coverage-final.json`, or other common formats
2. Lets you pick a file with the lowest coverage
3. Annotates uncovered lines and sends a targeted "write tests for these lines" prompt

---

### PR Context (`/pr`)
Fetches the open GitHub PR for the current branch and injects the title, description, changed files, review comments, and commit messages. Requires a GitHub token stored via **Codico: Set GitHub Token**.

---

### Ask about a Git Diff Hunk
Right-click a changed file in SCM → **Ask Codico about this diff** to explain, review, or improve a specific diff hunk.

---

### Commit Message Generation
Click the **Codico** button in the Source Control panel header to generate a commit message from the current staged diff. Needs an OpenRouter model (the agent's own auto-commit works with every provider).

---

### Workspace Semantic Search Index
Run **Codico: Index Workspace** to build a vector embedding index of all source files (up to 600 files, 60-line chunks). Used by `@workspace` for semantic retrieval:

- Index is persisted across sessions and incrementally updated as files change
- Falls back to keyword search when no API key is set or embeddings are unavailable
- Configure the embedding model via `codico.embeddingModel`

---

### Suggest Rename
Right-click any symbol → **Suggest Rename** — the agent proposes a more meaningful name based on context and usage. With `codico.renameSuggestionsEnabled`, the built-in rename box (`F2`) is also pre-filled with an AI-suggested name.

---

### Next Edit Suggestions
After you make a change, the agent predicts the next related edit and shows it as a suggestion; press `Tab` to accept. Toggle with `codico.nextEditSuggestionsEnabled`.

---

### Explain Terminal Errors
Select failing output in the integrated terminal, right-click → **Explain Error with Codico** to send it to the chat for a diagnosis.

---

### Excluding Files (`.codicoignore`)
Add a `.codicoignore` file (gitignore syntax) to any workspace root to exclude matching files from Codico's semantic index and agent file surfaces. The policy is enforced for `read_file`, `list_directory`, `search_files`, `find_files`, `write_file`, `edit_file`, and diagnostics, and changes are picked up automatically. Multi-root workspaces keep separate rules per root.

Existing `.copilotignore` files are still read for compatibility; `.codicoignore` is the Codico-specific policy and its later rules can override legacy matches. Terminal commands are a separate permission boundary: an approved shell command can still access files that the operating system allows, so do not treat ignore rules as a shell sandbox. Terminal subprocesses no longer inherit arbitrary VS Code process secrets by default.

---

### MCP (Model Context Protocol) Servers

**The catalog.** Click **🔌 MCP** in the chat header for a short list of known servers, each checked to connect with Codico and pinned to a version:

| Server | By | What it adds |
|---|---|---|
| Playwright | Microsoft | Drive a real browser: open pages, click, fill forms, read the page and its console |
| Chrome DevTools | Google | Inspect a page in Chrome: network, console, performance traces, screenshots |
| Context7 | Upstash | Current documentation and examples for a library |
| Memory | Model Context Protocol | A small knowledge graph the agent keeps across conversations |
| Sequential Thinking | Model Context Protocol | A scratchpad for working through a problem in steps |

Each card shows the exact command the server runs. **Add…** opens a VS Code dialog with that command, what it requires and how many tools it adds, and asks where to put it: **this project** (`.mcp.json`, shared with everyone who opens the project) or **all projects** (your user settings). Nothing is written or started until you choose. **Remove** takes it out again. These servers need Node.js; a server that needs an API key is not in the catalog yet — add those by hand as below.

Each tool a server adds is described to the model on every request, so a 30-tool server costs tokens even when unused: add what you use.
Connect any MCP-compatible tool server via settings or a `.mcp.json` file in the workspace root. Connected tools appear in the system prompt and can be called with `mcp_call` blocks.

- Workspace-defined servers need your approval the first time; an invalid `.mcp.json` is reported instead of silently ignored
- Results are treated as untrusted content and capped at 20,000 characters
- **■ Stop** cancels a running MCP call (and tells the server); calls may otherwise run up to 5 minutes

---

### Repo-Level Custom Instructions
The agent reads and applies instructions from any of these files (all found files are merged):

1. `.codico-instructions.md` (workspace root)
2. `.github/codico-instructions.md`
3. `.github/copilot-instructions.md`

Changes to these files invalidate the cache immediately — no reload required.

---

### Provider, Model & Thinking Effort
The chat header has two menus. **Provider** chooses where the model runs and whose key is used: OpenRouter, Claude Code or ChatGPT (your own login, no key), a direct provider (your own key) or local Ollama. Providers without a key are marked "no key", and picking one asks for its key. **Model** then lists only that provider's models, and each provider remembers the model you last used with it.

If the selected model needs an OpenRouter key that is not set but you have a direct provider key, Codico switches to that provider and tells you.

The models, by provider:

**🔑 Direct (your own keys)**
- Anthropic: Claude Opus 4.5, Sonnet 4.5, Haiku 4.5, Claude 3.5 Sonnet
- OpenAI: GPT-6.1 Sol, GPT-6 Sol, GPT-6 Astra, GPT-6 Luna, GPT-5.5, GPT-5.4 Mini (reasoning effort follows the header selector)
- Google: Gemini 3.8 Flash, Gemini 3.5 Flash, Gemini 3.5 Flash Lite, Gemini 3.1 Pro, Gemini 2.5 Pro, Gemini 2.5 Flash (thinking shown; thinking level follows the header selector)
- Groq: Llama 3.3 70B, Llama 3.1 8B Instant, DeepSeek R1 70B
- DeepSeek: DeepSeek V4.1 Flash, DeepSeek V4 Pro (thinking shown; reasoning effort follows the header selector)
- Mistral: Mistral Large, Codestral, Mistral Small
- Grok (xAI): Grok 3, Grok 3 Mini
- Cerebras: Llama 4 Scout 17B, Llama 3.1 70B

**🆓 Free (via OpenRouter)** — zero-cost models only
- Qwen, Google (Gemma), NVIDIA (Nemotron), Poolside (Laguna), Cohere, Thinking Machines, InclusionAI and more, plus the OpenRouter free router

**💎 Premium (via OpenRouter)**
- Anthropic (Claude), OpenAI (GPT), Google (Gemini), DeepSeek, Qwen, xAI (Grok), Mistral, MoonshotAI (Kimi), Z.ai (GLM) and more
- The default model, **DeepSeek V4 Flash ★**, is in this group — it is inexpensive but not free

**Ollama (local)**
- `ollama/qwen2.5-coder:7b`, `:14b`, `:32b`
- `ollama/qwen3:8b`, `:14b`, `:30b-a3b`
- `ollama/deepseek-r1:7b`, `:14b`, `deepseek-coder-v2`
- `ollama/codellama:13b`, `llama3.1:8b`, `mistral:7b`, `gemma3:4b`, `:12b`

Adjust the **thinking effort** (High / Medium / Low) for reasoning models via the header selector. The default is **Medium**: High spends noticeably more reasoning tokens on every step.

---

## Setup

### 1. Install and compile

```bash
npm install
npm run compile
```

### 2. Choose your provider

**Option A — Direct provider (your own key, no intermediary):**
```
Ctrl+Shift+P → Codico: Set Direct Provider API Key
```
Pick a provider (Anthropic, OpenAI, Google, Groq, DeepSeek…), paste your key. Then select a 🔑 model from the dropdown.

**Option B — OpenRouter (one key, many models):**
```
Ctrl+Shift+P → Codico: Set OpenRouter API Key
```
Or click ⚙ in the chat panel → **OpenRouter API Key**.

**Option C — Local Ollama (no key, fully offline):**
```
Ctrl+Shift+P → Codico: Set Ollama Base URL
```
Then select any `ollama/` model from the dropdown.

### 3. Optional: enable cloud semantic indexing

Semantic indexing is **off by default** because embedding requests send source-code chunks to OpenRouter. You can still use Codico without it; workspace search falls back to local keyword/tool-based retrieval.

To opt in:

```
Settings → Codico: Auto Index
```

You can also run **Codico: Index Workspace (Semantic Search)** manually when you want to build an index.

### 4. Open the panel

```
Ctrl+Shift+L   — focus chat directly
```

Or click the Codico icon in the Activity Bar.

---

## Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `codico.model` | `string` | `deepseek/deepseek-v4-flash` | Model ID: OpenRouter ID, `direct:provider/model`, or `ollama/model` |
| `codico.ollamaBaseUrl` | `string` | `http://localhost:11434` | Ollama server URL |
| `codico.systemPrompt` | `string` | `""` | Optional prefix prepended to the system prompt |
| `codico.autoInjectContext` | `boolean` | `true` | Auto-include active file path as context |
| `codico.maxIterations` | `number` | `0` | Max agentic loop iterations per message (`0` = no limit) |
| `codico.taskTokenBudget` | `number` | `0` | Pause and ask whether to continue each time a task uses this many more tokens (`0` = no budget) |
| `codico.terminalTimeoutSeconds` | `number` | `300` | Kill a terminal command and its child processes after this many seconds |
| `codico.streamStallTimeoutSeconds` | `number` | `300` | Treat a response that sends nothing for this long as a dropped connection and reconnect |
| `codico.verificationGraceIterations` | `number` | `4` | Extra steps allowed to verify a change after the step limit is reached |
| `codico.mutationGraceIterations` | `number` | `3` | Extra steps allowed to make a required code change after the step limit is reached |
| `codico.nativeToolCalling` | `boolean` | `true` | Prefer provider-native structured tools; disable to force fenced compatibility mode |
| `codico.browserAllowPrivateNetwork` | `boolean` | `false` | Allow browser automation to access localhost/private/internal destinations |
| `codico.inlineCompletionsEnabled` | `boolean` | `true` | Enable ghost-text inline completions |
| `codico.inlineCompletionsDebounceMs` | `number` | `600` | Debounce delay (ms) before requesting a completion |
| `codico.openTabsContext` | `boolean` | `true` | Tell the agent which other files are open in tabs (their names; contents are read only when the task needs them) |
| `codico.globalHistory` | `boolean` | `false` | Persist threads across all workspaces |
| `codico.autoInjectDiagnostics` | `boolean` | `true` | Auto-inject Problems panel errors/warnings |
| `codico.completionNotificationsEnabled` | `boolean` | `true` | Notify when agent finishes while window is unfocused |
| `codico.completionNotificationThresholdMs` | `number` | `5000` | Minimum task duration before notifying (ms) |
| `codico.proactiveErrorDetection` | `boolean` | `true` | Offer to fix errors when opening a file with problems |
| `codico.followUpSuggestionsEnabled` | `boolean` | `true` | Show follow-up chips after each response |
| `codico.symbolContextEnabled` | `boolean` | `true` | Include LSP symbol info for the symbol under cursor |
| `codico.codeLensEnabled` | `boolean` | `true` | Show Explain / Fix CodeLens above functions |
| `codico.embeddingModel` | `string` | `nomic-ai/nomic-embed-text` | Model used for workspace index embeddings |
| `codico.autoIndex` | `boolean` | `false` | Opt in to automatic semantic indexing. Cloud embeddings send code chunks to OpenRouter |
| `codico.mcpServers` | `array` | `[]` | MCP server configurations |
| `codico.nextEditSuggestionsEnabled` | `boolean` | `true` | Show AI-predicted next edit suggestions (Tab to accept) |
| `codico.renameSuggestionsEnabled` | `boolean` | `true` | Pre-fill the rename input (F2) with an AI-suggested name |
| `codico.responseSummaryEnabled` | `boolean` | `true` | Append a short Summary and Conclusion block to AI responses |
| `codico.autoCompactThreshold` | `number` | `60000` | Token count that triggers auto-compaction (when enabled) |
| `codico.claudeCodePath` | `string` | `""` | Path to the `claude` command for the Claude Code provider (empty: PATH, then the Claude Code VS Code extension) |
| `codico.codeSearchMaxFiles` | `number` | `5000` | Files indexed by the local code search (`search_code`) |
| `codico.subagentMaxSteps` | `number` | `10` | Requests a subagent may make before it must write its report |
| `codico.changeReport` | `boolean` | `true` | Show a change report after a reply that changed files |
| `codico.notifications` | `string` | `"whenAway"` | Notify when Codico finishes or needs you while you are not looking at the chat (`off` to disable) |
| `codico.codexPath` | `string` | `""` | Path to the `codex` command for the ChatGPT provider (empty: PATH, then OpenAI's VS Code extension) |
| `codico.chatDensity` | `string` | `comfortable` | Chat panel spacing: `comfortable` or `compact` |
| `codico.showReasoning` | `boolean` | `true` | Show the model's reasoning blocks in the chat |

---

## Project Structure

```
codico/
├── src/
│   ├── extension.ts                 # Activation, command registration
│   ├── agentProvider.ts             # Agent orchestration loop, workspace tools, thread/session coordination
│   ├── agentPrompts.ts              # Plan-mode and code-review prompts
│   ├── agentPhasePrompt.ts          # Phase guidance (act, verify), sent as conversation notes
│   ├── explorationController.ts     # Exploration/verification phases of a task
│   ├── iterationBudget.ts           # Whether another autonomous step may run
│   ├── toolLoopGuard.ts             # Repeated-call detection that ignores repeats after changes
│   ├── contextPreamble.ts           # The [Context] block sent with each message
│   ├── contextProjection.ts         # Shortens older/duplicate tool results sent to the model
│   ├── historyCompaction.ts         # Compaction planning; plan-approval context slimming
│   ├── threadEditing.ts             # Edit / delete / regenerate: cut the thread at a turn
│   ├── taskUsage.ts                 # Per-task token and cost accounting and budget
│   ├── chatFiles.ts                 # Dropped files, file links, change diffs
│   ├── workspaceText.ts             # Reads/writes that respect unsaved editors and later changes
│   ├── lineDiff.ts                  # Line diffs for approval cards and results
│   ├── editorModel.ts               # Which models the editor features can use
│   ├── externalToolRuntime.ts       # Browser/network/MCP/LSP/debug tool handlers
│   ├── chatProtocol.ts              # Shared extension↔webview message contracts
│   ├── webviewAssets.ts             # Webview asset preload, CSP and URI rendering
│   ├── evaluationMetrics.ts         # Test-host coding benchmark metrics contract
│   ├── agentRouter.ts               # @workspace / @terminal / @vscode / @github context builders
│   ├── openRouterClient.ts          # OpenRouter SSE streaming client + system prompt
│   ├── ollamaClient.ts              # Ollama OpenAI-compatible streaming client
│   ├── directProviderClient.ts      # Direct provider streaming (Anthropic, OpenAI-compat, Google)
│   ├── deepseekAdapter.ts           # DeepSeek's differences from the OpenAI protocol (thinking, reasoning replay, cache hits)
│   ├── claudeCodeClient.ts          # Claude Code as a provider: runs the claude command as a model, parses its stream
│   ├── claudeCodePath.ts            # Finds the claude command (setting, PATH, Claude Code extension)
│   ├── modelFallback.ts             # Provider of a model, key status, fallback when a key is missing
│   ├── toolParser.ts                # Tool-call fence scanner/parser (handles nested code blocks)
│   ├── nativeTools.ts               # Provider-neutral JSON schemas + native tool-call decoding
│   ├── providerConversation.ts      # OpenAI/Anthropic/Gemini native tool history serializers
│   ├── agentHistory.ts              # Provider-aware assistant/tool-result history mutation
│   ├── workspaceDiagnostics.ts      # Workspace Problems summary/count helpers
│   ├── streamCompletion.ts          # Stream cutoff detection and resume helpers
│   ├── networkSecurity.ts           # Public-address/DNS validation (incl. IPv4 embedded in IPv6) and pinned lookups
│   ├── untrustedContent.ts          # Marks web/browser/MCP content as untrusted for the model
│   ├── browserNetworkPolicy.ts      # Browser public/private-network request policy
│   ├── urlFetcher.ts                # Secure public URL fetch + redirect/text handling
│   ├── terminalProcess.ts           # Cross-platform command/process-tree lifecycle + scrubbed environment
│   ├── mcpEnvironment.ts            # Minimal environment policy for MCP child processes
│   ├── testOrchestrator.ts          # Test-command detection and the /test fix loop prompt
│   ├── indexPersistence.ts          # Workspace index storage (vectors + hashes, no raw source)
│   ├── fileManager.ts               # File writes routed through centralized workspace policy
│   ├── workspaceSecurity.ts         # Multi-root confinement + .codicoignore enforcement
│   ├── codeLensProvider.ts          # Explain / Fix CodeLens above function definitions
│   ├── coverageProvider.ts          # LCOV / Istanbul JSON parser, coverage prompt builder
│   ├── prContextProvider.ts         # GitHub PR context fetcher + formatter
│   ├── workspaceIndex.ts            # Semantic search index (embeddings + keyword fallback)
│   ├── inlineCompletionProvider.ts  # Ghost-text completions
│   ├── inlineChatProvider.ts        # Inline chat widget + editor diff accept/reject
│   ├── commitMessageProvider.ts     # Commit message generation from staged diff
│   ├── renameProvider.ts            # AI-powered rename suggestion
│   ├── nextEditProvider.ts          # Next-edit prediction completions
│   ├── browserManager.ts            # Playwright browser wrapper
│   ├── mcpClient.ts / mcpManager.ts # MCP server connection management
│   ├── undoRedoStack.ts             # AI change undo/redo history
│   ├── editProposalManager.ts       # Edits Mode diff queue
│   ├── symbolProvider.ts            # LSP symbol context builder
│   └── ignoreRules.ts               # Per-root .codicoignore + legacy .copilotignore policy
├── tests/                           # node:test regression + architecture/holdout integrity tests
├── eval/                            # Frozen historical coding holdout + VS Code benchmark driver
├── scripts/eval/run.js              # Worktree runner, hidden verifier injection, scorecard output
├── .github/workflows/ci.yml         # CI: compile/tests on 3 OSes + VSIX packaging gate
├── .github/workflows/release.yml    # Tag/release-branch GitHub release + manual Marketplace/Open VSX publishing
├── .github/workflows/eval.yml       # Manual-only frozen coding holdout
├── media/
│   ├── chat.html                    # Small structural webview shell
│   ├── chat.css                     # Webview presentation layer
│   ├── chat.js                      # Main webview behavior
│   ├── markdown.js                  # Extracted Markdown/tool-fence renderer
│   ├── streamNotices.js             # Extracted cutoff/error/continue UI
│   ├── models.json                  # Model list for the dropdown (free / premium / direct / local)
│   └── icon.svg                     # Activity bar icon
├── out/                             # Compiled JS (git-ignored)
├── package.json
└── tsconfig.json
```

---

## Security

- **Centralized workspace confinement** — agent file paths are normalized through one multi-root-aware policy before reads, listings, searches, writes, edits, or file-scoped diagnostics; paths that lead outside the workspace through a symbolic link (or a dangling one) are refused
- **Open tabs** — only the names of other open tabs are sent with a message, never their contents, and a tab outside the workspace or excluded by `.codicoignore` is not named
- **`.codicoignore` enforcement** — per-root gitignore-style rules hide matching paths from Codico file tools and diagnostics; `.copilotignore` remains supported as a compatibility source
- **Remembered commands** — a terminal command runs without asking only if you chose "Always allow" for it on its approval card. A rule is either one whole command, matched exactly, or a build/test command with any arguments (`npm test *`), which never matches a command that chains, pipes, redirects or substitutes (`npm test; …`, `&&`, `|`, `>`, `$( )`, backticks). Rules live in the workspace's private state, not in a settings file a repository could ship, do not apply in an untrusted folder, and are set aside for the rest of a turn once the agent has read web or MCP content
- **Permission dialogs** — file writes and terminal commands require approval; network fetches, browser actions, and MCP tool calls are separately gated before they can affect external systems
- **Terminal secret scrubbing** — approved shell commands inherit only an execution/toolchain allowlist (PATH, HOME, Java/Go/Python/Node toolchain roots, temp/system paths, locale), not arbitrary VS Code process secrets
- **Secret storage** — all API keys (OpenRouter, direct providers, GitHub token) are stored in VS Code's encrypted `SecretStorage`, never in plain `settings.json`
- **Content Security Policy** — the webview uses a strict CSP with per-session cryptographically random nonces; the extracted webview module is loaded only through a VS Code `asWebviewUri` resource
- **Workspace trust** — Codico declares untrusted workspaces unsupported and will not start workspace-defined MCP servers without explicit approval
- **MCP trust boundary** — `.mcp.json` / `mcp.json` servers require first-run approval; persistent approval is tied to the exact command/config fingerprint, and MCP child processes inherit only a minimal runtime environment unless variables are explicitly configured
- **Project hooks** — commands in `.codico/hooks.json` run only in a trusted workspace and only after you approved that exact command; they get the reduced terminal environment, a timeout, and no way to widen what the agent may do: a hook can refuse a call or add text to its result, never approve one
- **Network SSRF protection** — `fetch_url` rejects private/loopback/link-local/reserved DNS answers (including IPv6 forms that embed such an IPv4 address, such as `[::ffff:127.0.0.1]`), pins the socket to the validated address set to resist DNS rebinding, and repeats validation on every redirect hop
- **Browser network boundary** — browser automation rejects malformed and non-HTTP(S) schemes and validates every HTTP(S) navigation, redirect, subresource and WebSocket against the public-network policy by default. Set `codico.browserAllowPrivateNetwork=true` only when you intentionally need localhost/internal apps
- **Semantic-index privacy** — cloud semantic indexing is opt-in by default; persisted indexes store vectors/metadata and hashes, not raw source text
- **No telemetry** — no usage data is collected; model/API calls go directly from your machine to the configured provider

---

## Validation

Every pull request runs the regression suite on **Ubuntu, Windows, and macOS**, activates Codico inside a real VS Code Extension Host, packages a VSIX, and smoke-installs that packaged extension into a clean VS Code profile.

For autonomous coding quality, Codico also ships a frozen **26-task historical coding holdout**. The current agent is run against exact pre-fix Codico commits and the relevant regression test is injected only after the agent finishes, so the verifier is hidden during the task. The holdout records success, duration, agent steps, tool calls, changed files, and provider token usage.

The coding holdout is intentionally **manual-only** and never consumes model credits on ordinary pushes or pull requests. See [eval/README.md](eval/README.md) for the frozen-v1 methodology and reproduction commands.

## Development

```bash
# Watch mode — recompiles on every save
npm run watch

# Run the compile + regression suite
npm test

# Chat panel UI tests in headless Chrome (set CHROME_PATH if Chrome isn't auto-detected)
npm run test:ui

# Live agent scenarios: the real agent loop in VS Code against a local fake model server
# (no API key, no cost; Linux/macOS)
npm install --no-save @vscode/test-electron@2.5.2
npm run test:live

# Press F5 in VS Code to launch the Extension Development Host
```

CI runs compile/regression tests on Linux, Windows, and macOS, then launches Codico inside a real VS Code Extension Host and smoke-installs the packaged VSIX before uploading it as an artifact.

To package locally:

```bash
npx @vscode/vsce package --out codico.vsix
```

### Releases

- The **0.3.x** line added task token/cost tracking, read-only Plan mode, prompt caching and leaner context, safer file handling, MCP and network-security fixes, and the chat features above (message actions, grouped steps, progress header, file links, drag and drop). See [CHANGELOG.md](CHANGELOG.md) for each release.
- Push a tag matching the package version (for example `v0.2.0`) to run the release workflow, rebuild/test the extension, run the Extension Host and VSIX-install smoke gates, create `codico.vsix`, and attach it to a GitHub Release.
- Maintainers can also create a `release/vX.Y.Z` branch at the validated release commit. The workflow validates the package version, creates the matching tag, packages the VSIX, and creates/updates the GitHub Release.
- Release-branch runs create the validated Git tag and GitHub Release from the exact release commit.
- Manual workflow dispatch remains the explicit path for Visual Studio Marketplace (`VSCE_PAT`) and Open VSX (`OVSX_PAT`) publication.
- Release automation rejects a version/ref mismatch instead of publishing an ambiguously versioned package.
