# Codico

An autonomous coding agent embedded directly in VS Code. Connect directly to major providers with your own keys — Anthropic, OpenAI, Google, Groq, DeepSeek, Mistral, Grok, and Cerebras — access many additional providers through **OpenRouter**, or run fully offline with **Ollama**.

The agent reasons through problems, reads and writes files, runs terminal commands, searches code, applies targeted edits, and iterates autonomously — all from a sidebar chat panel.

---

## Providers

### Direct Provider Connections
Call AI providers directly with your own API keys — no OpenRouter account required:

| Provider | Models | Key command |
|---|---|---|
| **Anthropic** | Claude Opus 4.5, Sonnet 4.5, Haiku 4.5, Claude 3.5 Sonnet | `Codico: Set Direct Provider API Key` |
| **OpenAI** | GPT-4o, GPT-4o Mini, o3, o4-mini | `Codico: Set Direct Provider API Key` |
| **Google** | Gemini 2.0 Flash, Gemini 2.5 Pro, Gemini 1.5 Flash | `Codico: Set Direct Provider API Key` |
| **Groq** | Llama 3.3 70B, Llama 3.1 8B Instant, DeepSeek R1 70B | `Codico: Set Direct Provider API Key` |
| **DeepSeek** | DeepSeek V3, DeepSeek R1 | `Codico: Set Direct Provider API Key` |
| **Mistral** | Mistral Large, Codestral, Mistral Small | `Codico: Set Direct Provider API Key` |
| **Grok (xAI)** | Grok 3, Grok 3 Mini | `Codico: Set Direct Provider API Key` |
| **Cerebras** | Llama 4 Scout 17B, Llama 3.1 70B | `Codico: Set Direct Provider API Key` |

Direct models appear in the model picker under a 🔑 section. Each provider stores its key independently in VS Code's encrypted `SecretStorage`.

### OpenRouter
Access hundreds of models through a single API key — including free-tier models from Qwen, Google, NVIDIA, Poolside, Cohere, and more. Set your key via `Codico: Set OpenRouter API Key` or the ⚙ settings menu.

### Local Models (Ollama)
Run entirely offline. Prefix any model ID with `ollama/` — e.g. `ollama/qwen2.5-coder:7b`. No API key required.

---

## Features

### Agentic Loop
After each response the agent executes any tool calls, feeds the results back to the model, and keeps working until the task is complete — without requiring follow-up from you.

- **No step limit by default** (`codico.maxIterations`, `0` = unlimited). The status bar shows the current step.
- **Checkpoints** — every `codico.checkpointSteps` steps (default 50) the agent pauses and asks **▶ Continue** or **Stop here**, so a run that has gone off track can't spend tokens indefinitely.
- **Loop detection** — a tool call repeated with identical arguments more than 3 times is blocked and the model is told to try a different approach.
- **Automatic recovery** — if a response is cut off (output-token limit or dropped connection), the agent resumes in the same message: half-written tool calls are re-issued, repeated text is trimmed, and up to 5 retries are made with backoff. The status bar shows *Reconnecting…* meanwhile.
- **Stalled turns** — if the model announces an action ("I'll read the file…") but emits no tool call, or forgets to close its last tool call, the agent recovers instead of stopping.

### Live Thinking Visualization
For reasoning models (DeepSeek R1, Qwen3, etc.) the agent's internal chain-of-thought is shown in a collapsible "Reasoning trace" panel above each response, streamed in real time.

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
| `fetch_url` | Download and read any URL |
| `lsp_symbol` | Look up symbol definitions/references via the language server |
| `browser_*` | Full browser automation (navigate, click, type, screenshot, get text) via Playwright |
| `mcp_call` | Call any tool exposed by a connected MCP server |
| `update_todo` | Declare and live-update a task checklist visible in the chat |
| `debug_get_variables` | Inspect local variables from the active debug session |
| `debug_get_callstack` | Read full call stack across all threads |
| `debug_list_breakpoints` | List all breakpoints with location, condition, and enabled state |

Every tool that modifies files or runs code shows a **permission dialog** — you can allow or deny each one individually, or click **Allow All** to approve the rest of the current response (permissions reset with each new message).

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
- A command that leaves a process running in the background (e.g. `nohup npm start &`) no longer blocks the agent. The status bar shows a **⚙ N background processes ✕** chip — hover to see the commands, click to stop them. They are also stopped when VS Code closes.

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
- Green `+` / red `−` lines with context, `@@` hunk separators, and scroll truncation for large files
- Click `▶ +N −M lines changed` to expand/collapse

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

### Chat History Search
Click the **🔍** button in the thread tab bar to search across all threads:

- Debounced live search as you type — matches both thread names and message content
- Results show thread name, role indicator (▶ user / ◀ assistant), and highlighted snippets around each match
- Click any result to jump directly to that thread
- Keyboard navigation: `↑`/`↓` to move between results, `Enter` to open, `Esc` to close

---

### Named Chat Threads
Manage multiple independent conversations per project:

- A **thread bar** shows all sessions as vertical cards with name, timestamp, rename (✏) and delete (🗑) buttons
- Click **+** to create a new thread; click 🔍 to search across all threads
- The first message in a new thread auto-names it immediately
- Reopening a thread — or reloading the window — restores the full conversation exactly as it streamed: text, reasoning, tool steps, diffs and terminal output (about 400k characters per reply are stored; threads saved by older versions show short summaries)
- If the window closed while the agent was mid-task, a **Session was interrupted — resume?** banner offers to continue it
- Threads are persisted to `workspaceState` (per-project) or `globalState` (cross-window) depending on `codico.globalHistory`

---

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+L` / `Cmd+Shift+L` | Focus the chat panel and input box |
| `Ctrl+I` | Inline Chat: edit selected code with AI |
| `Ctrl+Enter` | Accept inline diff |
| `Esc` | Reject inline diff |

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

Context chips appear as removable badges before sending.

**Images** — attach screenshots or diagrams with the **📎** button, by pasting, or by drag-and-drop (requires a vision-capable model).

---

### Chat Modes
The toggle under the input box switches how the next message is handled:

- **💬 Ask** — read-only: the agent searches and answers; file writes, edits, terminal commands, browser actions and MCP calls are blocked
- **📋 Plan** — the agent first produces a step-by-step plan; approve it to execute (same as `/plan`)
- **🤖 Agent** — fully autonomous with all tools (default)

While a response is streaming, **Send** becomes **Queue →**: your next message is sent automatically when the current response finishes.

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

---

### Inline Completions (Ghost Text)
As you type, the agent suggests completions inline (grey ghost text). Press `Tab` to accept. Works with all providers. Configure with:

- `codico.inlineCompletionsEnabled` — enable/disable (default: `true`)
- `codico.inlineCompletionsDebounceMs` — delay before triggering (default: `600`)

---

### Edits Mode (Multi-file Diff Review)
Click the **✏ Edits** toggle in the header to enter Edits Mode:

- The agent queues all file changes as proposals rather than writing them immediately
- Each proposal appears as a diff card with **Accept** and **Reject** buttons
- Use **Accept All** / **Reject All** for bulk operations
- **Undo / Redo** (↩ ↪) let you reverse any accepted AI change

---

### Context Compaction
Keep long sessions efficient:

- **↓↑ Compact context** button — summarize the conversation history immediately to reduce token usage
- **↙ Auto-compact** toggle (on by default) — automatically compact when prompt tokens exceed `codico.autoCompactThreshold` (default: 100,000 tokens), including between steps of a running task
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
Click the **Codico** button in the Source Control panel header to generate a commit message from the current staged diff. Works with all providers.

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

### Excluding Files (`.copilotignore`)
Add a `.copilotignore` file (gitignore syntax) to the workspace root to exclude matching files from the semantic workspace index, inline completions and next-edit suggestions. Changes are picked up automatically. It does not stop the agent's own tools — the agent can still open an ignored file with `read_file` if asked.

---

### MCP (Model Context Protocol) Servers
Connect any MCP-compatible tool server via settings or a `.mcp.json` file in the workspace root. Connected tools appear in the system prompt and can be called with `mcp_call` blocks.

---

### Repo-Level Custom Instructions
The agent reads and applies instructions from any of these files (all found files are merged):

1. `.codico-instructions.md` (workspace root)
2. `.github/codico-instructions.md`
3. `.github/copilot-instructions.md`

Changes to these files invalidate the cache immediately — no reload required.

---

### Model & Thinking Effort
Switch models from the chat header dropdown. Models are grouped by tier:

**🔑 Direct (your own keys)**
- Anthropic: Claude Opus 4.5, Sonnet 4.5, Haiku 4.5, Claude 3.5 Sonnet
- OpenAI: GPT-4o, GPT-4o Mini, o3, o4-mini
- Google: Gemini 2.0 Flash, Gemini 2.5 Pro, Gemini 1.5 Flash
- Groq: Llama 3.3 70B, Llama 3.1 8B Instant, DeepSeek R1 70B
- DeepSeek: DeepSeek V3, DeepSeek R1
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

Adjust the **thinking effort** (High / Medium / Low) for reasoning models via the header selector.

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
| `codico.checkpointSteps` | `number` | `50` | Pause and ask whether to continue every N steps (`0` = never) |
| `codico.terminalTimeoutSeconds` | `number` | `300` | Kill a terminal command and its child processes after this many seconds |
| `codico.inlineCompletionsEnabled` | `boolean` | `true` | Enable ghost-text inline completions |
| `codico.inlineCompletionsDebounceMs` | `number` | `600` | Debounce delay (ms) before requesting a completion |
| `codico.openTabsContext` | `boolean` | `true` | Include open editor tabs as additional context |
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
| `codico.autoCompactThreshold` | `number` | `100000` | Token count that triggers auto-compaction (when enabled) |

---

## Project Structure

```
codico/
├── src/
│   ├── extension.ts                 # Activation, command registration
│   ├── agentProvider.ts             # WebviewViewProvider, agentic loop, tool handlers, thread management
│   ├── agentRouter.ts               # @workspace / @terminal / @vscode / @github context builders
│   ├── openRouterClient.ts          # OpenRouter SSE streaming client + system prompt
│   ├── ollamaClient.ts              # Ollama OpenAI-compatible streaming client
│   ├── directProviderClient.ts      # Direct provider streaming (Anthropic, OpenAI-compat, Google)
│   ├── toolParser.ts                # Tool-call fence scanner/parser (handles nested code blocks)
│   ├── streamCompletion.ts          # Stream cutoff detection and resume helpers
│   ├── testOrchestrator.ts          # Test-command detection and the /test fix loop prompt
│   ├── indexPersistence.ts          # Workspace index storage (vectors + hashes, no raw source)
│   ├── fileManager.ts               # File write with path-traversal guard + permission dialog
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
│   └── ignoreRules.ts               # .copilotignore watcher
├── tests/                           # node:test regression suite (runs against out/)
├── .github/workflows/ci.yml         # CI: compile + tests on Linux, Windows, macOS
├── media/
│   ├── chat.html                    # Self-contained webview UI (vanilla JS, no bundler)
│   ├── models.json                  # Model list for the dropdown (free / premium / direct / local)
│   └── icon.svg                     # Activity bar icon
├── out/                             # Compiled JS (git-ignored)
├── package.json
└── tsconfig.json
```

---

## Security

- **Path traversal prevention** — all file paths are normalized and checked to stay inside the workspace root before any read or write
- **Permission dialogs** — file writes and terminal commands require approval; network fetches, browser actions, and MCP tool calls are separately gated before they can affect external systems
- **Secret storage** — all API keys (OpenRouter, direct providers, GitHub token) are stored in VS Code's encrypted `SecretStorage`, never in plain `settings.json`
- **Content Security Policy** — the webview uses a strict CSP with per-session cryptographically random nonces; no inline scripts or external resources
- **Workspace trust** — Codico declares untrusted workspaces unsupported and will not start workspace-defined MCP servers without explicit approval
- **MCP trust boundary** — `.mcp.json` / `mcp.json` servers require first-run approval; persistent approval is tied to the exact command/config fingerprint
- **Semantic-index privacy** — cloud semantic indexing is opt-in by default; persisted indexes store vectors/metadata and hashes, not raw source text
- **No telemetry** — no usage data is collected; model/API calls go directly from your machine to the configured provider

---

## Development

```bash
# Watch mode — recompiles on every save
npm run watch

# Run the compile + regression suite
npm test

# Press F5 in VS Code to launch the Extension Development Host
```

CI runs the same checks on Linux, Windows, and macOS.

To package:

```bash
npm install -g @vscode/vsce
vsce package
```
