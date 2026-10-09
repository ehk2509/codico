# Changelog

All notable changes to Codico will be documented in this file.

## 0.3.6 - 2026-10-09

### Added
- Edit and resend a message (✎ on hover): the conversation is cut back to that message and the edited text is sent; for a Plan-mode message the goal is edited. Delete (🗑) removes a message and everything after it, after a confirmation. The panel, the saved thread and the history the model sees are cut at the same point. Messages already folded into a compaction summary cannot be changed.
- Regenerate (↻) on the latest reply runs its message again and replaces the reply.
- Message times ("2m ago", full date on hover), saved with the thread so reopened conversations show when messages were sent.
- Long code blocks (over 25 lines) in finished replies are collapsed to a preview with an Expand button; the header shows the line count.
- File paths in replies (`src/app.ts:42`, or a path with a folder in plain text) and in tool steps (Reading / Editing / Written) open the file, at the line when one is given.
- Keyboard: ↑ in an empty input edits your last message; Esc stops the reply.
- While a reply streams, scrolling up to read no longer gets pulled back to the bottom; a "↓ Jump to latest" button returns to it.
- Drag and drop files onto the chat to attach them: text files as file context, images as image attachments. From VS Code's Explorer hold Shift while dragging; workspace files excluded by `.codicoignore` are refused.

### Changed
- An approved plan is saved in the thread as "✅ Plan approved — executing…", as shown live, instead of the full execution prompt.

## 0.3.5 - 2026-10-09

### Changed
- Prompt caching: requests to Claude models (direct and through OpenRouter) now ask the provider to cache the conversation, so each request in a task re-reads what was already sent at about a tenth of the price. The system prompt and tool list no longer change during a task (phase guidance is added to the conversation instead), so providers that cache automatically (OpenAI, DeepSeek, Gemini, Grok…) get cache hits too. The token counter shows the cached share. On a recorded 63-request task, billed input dropped from ~6.0M to the equivalent of ~0.9M tokens at Claude cache pricing.
- Approving a plan removes the planning turn's file reads from the context (the plan stays); the agent re-reads what it needs. About 1M fewer tokens sent on the same task.
- A tool result repeated unchanged later in a task (e.g. a file read twice) is sent only once.

### Fixed
- While a change awaited verification there was no iteration limit, so a model whose tool calls could not run (repeats blocked as a loop, phase-blocked or invalid calls) kept going forever. The task now stops after three such iterations in a row.
- Security: `fetch_url` and the browser could reach localhost and cloud metadata through IPv6 forms that embed an IPv4 address (`http://[::ffff:127.0.0.1]` — URLs rewrite it to `[::ffff:7f00:1]`, which the filter did not recognise). IPv4-mapped, IPv4-compatible, NAT64, 6to4 and Teredo addresses are now checked by their embedded address.
- Security: browser pages could open WebSocket connections to local services (WebSockets are not covered by request routing); they now go through the same network policy.
- Terminal: commands got an open input, so one that prompts (an `npx` install, `npm init`) waited until the 5-minute timeout. Commands now get no input and fail at once.
- Terminal: the model saw only the first 4,000 characters of a command's output, missing the failures and summary that test runners and builds print last (it then re-ran them). It now sees the start and, mostly, the end; past the 1 MB capture limit the end is kept too.
- Inline completions, next-edit suggestions, AI rename, inline chat and commit messages sent the selected model to OpenRouter even when it was a direct-provider model (or Ollama, where unsupported), so every request failed — on every pause in typing for completions. They now explain that the model is not supported (once, for features that run while typing) instead of sending requests.
- Superseded inline-completion and next-edit requests were never settled (one stranded promise per keystroke).
- MCP: a request from the server (such as `ping`) could be taken as the reply to one of Codico's requests, because both sides number requests from 1; the tool list then came back empty or a tool call returned nothing. Server requests are now answered (`ping`) or declined.
- MCP: writing to a server that had exited could raise an unhandled pipe error and crash the extension host.
- MCP: a server whose handshake failed was left running in the background (on every start and Refresh MCP); it is now stopped.
- MCP: tool results had no size limit, so one large result was resent with every later request of the task. Results are now capped at 20,000 characters, with a note.
- MCP: Stop now cancels a running tool call (and tells the server); calls may run up to 5 minutes instead of failing after 30 seconds.
- MCP: an invalid `.mcp.json` was silently ignored as if missing; a warning now explains why its servers did not start.
- The loop guard flagged normal work as a loop: re-reading a file after editing it, or re-running the tests after a fix, was blocked from the 4th time in a task. Repeats now only count while nothing has changed (a write resets reads, searches and commands; a command resets reads); identical writes and edits still count.

## 0.3.4 - 2026-10-09

### Fixed
- Stop was ignored while a turn was still preparing its request (reading keys, building context, `/pr` and `@agent` lookups), so the whole task ran anyway; a thread switch or Clear in that window waited for the entire task. Stop now cancels the turn from its first moment.
- A failing panel action (accepting an edit, Undo/Redo, previewing a diff, refreshing MCP) during a running task marked the agent idle, so a queued message started while the task was still running. The running task is no longer affected.
- Errors while starting a queued message or a resumed session were silently lost; they are now shown in the panel.
- Turning Edits mode on or off, or refreshing MCP servers, during a running task now takes effect when the task ends, instead of discarding its pending proposals or disconnecting a server it was calling.
- Undo, Redo and accepting an Edits-mode proposal overwrote the file even if it had changed since (hand edits were silently lost). Codico now asks before overwriting a changed file.
- Approving a write or edit applied content computed before the prompt, overwriting changes the user made while it was open. Edits are now re-applied to the current file, and a write to a file that changed is not made (the model is told to re-read it).
- Files open with unsaved changes were read and edited on disk, so the model saw stale content and saving ended in a conflict. Codico now reads the editor's buffer and writes through it.
- write_file reported a failed write (and skipped Undo) when the file was written but could not be shown as text.
- After a repeated tool call was detected, later tool calls in the same response still ran; they are now skipped.
- Non-English text and emoji could be corrupted ("�") when a character arrived split across two network chunks, in the chat and in files the agent wrote. All providers, terminal output and helper requests now decode text across chunk boundaries.
- A provider that kept the connection open but stopped sending hung the task until Stop. After 5 minutes of silence (`codico.streamStallTimeoutSeconds`) the connection is now treated as dropped and the agent reconnects.
- Undo, Redo and Edits-mode proposals used the wrong file when the model gave an absolute path or a path in another folder of a multi-root workspace (Undo wrote a stray copy; accepting failed with "Unsafe file path rejected").
- Security: a symbolic link inside the workspace (e.g. `docs -> ~/.ssh`) let tools read or write files outside it. Paths that lead outside the workspace through a link, or through a dangling link, are now refused.
- A `<think>` tag split across chunks leaked the model's reasoning into the reply as raw text.

## 0.3.3 - 2026-10-09

### Changed
- Plan mode shows the plan as a card: numbered step badges, a bold title per step with its full description underneath, and inline code and bold rendered instead of raw markdown. Description lines written under a step heading are now kept; every step and its complete text are shown. The execution tracker shows each step in full.

### Fixed
- Bold text inside a plan step no longer loses its formatting.
- Switching, creating, deleting or clearing a thread while the agent was working let the running turn write into the other thread. These actions now stop the running turn first.
- A plan queued behind another plan could run without read-only mode; queued work now starts after the previous turn has fully finished.
- Edits mode kept only the last of several edits to the same file, and could not edit a file created by a pending write; edits now build on the pending proposal.
- Approve & Execute, follow-up chips, clarify answers, Review and editor commands were silently dropped while the agent was finishing a turn; they are now queued.
- Approval diffs were empty when every change was below line 500; diffs now cover the whole file.
- Pressing Stop just before a checkpoint could leave the turn waiting for a click.
- An error after mid-task compaction could corrupt the history with empty entries.
- Stop now also cancels an in-progress compaction summary (no further request is billed and the history is left unchanged).
- The Compact button could run at the same time as a message sent while it was starting.

## 0.3.2 - 2026-10-09

### Fixed
- Plan mode: answering the planner's clarifying question started a normal agent turn that edited files before any plan existed. The answer now continues the plan, read-only, with the original goal.
- Auto-compaction during a long task could erase the user's current request (the agent then lost the goal and answered something else) and leave a tool result without its call. Compaction now keeps the current request verbatim, summarises older work with recent information first, and only cuts between complete exchanges.
- `search_files` patterns like `a|b` sent without regex mode silently found nothing; when a literal search finds nothing and the pattern is clearly a regex, it is searched as one and the result says so.
- The "resume interrupted session" banner now names the latest request, and plan requests appear as "📋 Plan: …" in saved transcripts, thread names and notifications.

### Changed
- Codico marks where its injected `[Context]` ends and the user's own text begins (`[User request]`).

## 0.3.1 - 2026-10-09

### Fixed
- Plan mode withheld Approve & Execute for valid plans whose steps were written in bold, as headings, or as "Step N:" ("No plan steps were produced"). Those formats are now recognised, and a reply ending with "Approve the plan to begin execution" is always approvable.

## 0.3.0 - 2026-10-08

### Added
- Status bar shows the running token total for the current task and, with OpenRouter, its provider-reported cost.
- `codico.taskTokenBudget` (default 0 = off): pause with Continue / Stop each time a task uses that many more tokens.
- Panel UI test suite (`npm run test:ui`) and live scenarios for native tool calls and browser automation.

### Security
- Web pages, browser text and MCP tool output reach the model inside a delimited `<untrusted_content>` block, and the system prompt declares such blocks to be data, never instructions.
- After the agent reads external content in a turn, Allow All no longer auto-approves terminal commands; each is shown again with a note.

### Fixed
- Plan mode could change code before the plan was approved: plans are now generated under Ask-mode rules enforced in code (read-only tools, no "make a code change" reminders), and nothing changes until you click Approve & Execute.
- Plan mode's Approve & Execute button could go missing, or appear on an unrelated reply. It is now tied to the plan's own reply, and is shown only when the plan has numbered steps.
- Plan requests sent while the agent is finishing a turn are queued instead of dropped; Ask mode no longer gets "make a code change" reminders.
- Replies started by the extension (CodeLens, editor commands, `/test`, …) now show the Stop button and a working status.

### Changed
- Activation is much faster: `playwright-core` is loaded only on first browser use, and the extension is bundled with esbuild (load time ~0.7 s to ~0.05 s).
- The VSIX ships only the bundle and its one runtime dependency: 121 files / 2.9 MB, down from about 1,280 files / 9 MB (earlier releases also picked up test-harness packages from the build machine).
- Licensed under MIT.

## 0.2.2 - 2026-10-08

### Fixed
- Runaway verification loop: after a file write, a model that kept ending its turn without running a check was reminded indefinitely, sending model requests without limit (2,363 in 50 seconds in a live test, until the extension host ran out of memory). The turn now ends with a visible notice after 3 consecutive reminders that get no tool call; a model that is still calling tools continues as before.
- Writing documentation or plain-text files (`.md`, `.txt`, `.rst`, `LICENSE`, `CHANGELOG`, …) no longer requires a verification step.

### Added
- Live agent test suite (`npm run test:live`, CI job `live-agent`): 22 scenarios run the real agent loop in VS Code against a local fake model server, covering file edits, security boundaries, terminal limits, provider failures and stream recovery.

## 0.2.1 - 2026-10-08

### Fixed
- Native tool calling: a model calling `clarify` as a function no longer fails with "Provider returned invalid arguments for native tool clarify". The call is shown as the interactive clarifying question and the turn waits for the user's answer.
- Native tool calls naming an unknown tool or carrying unusable arguments now return an explanatory tool result, so the model can correct the call instead of the turn ending.
- Queued follow-up messages are no longer dropped when the previous turn is still finishing (saving history, auto-compacting, or waiting on the completion notification); they run as soon as the agent is free, and Stop cancels them.
- The README logo rendered as a broken image because `media/logo.png` is corrupt; the README now uses the intact `media/logo-128.png`.

### Changed
- The completion notification no longer keeps the agent busy until it is dismissed.
- Evaluation tasks and scripts (`eval/`, `scripts/`) are no longer shipped in the VSIX.

## 0.2.0 - 2026-10-08

### Added
- Optional local ACCO provider-boundary optimization for OpenRouter requests, disabled by default and fail-open without changing Codico's canonical history, agent loop, mutations, or verification state.
- ACCO evaluation telemetry for optimization attempts, changed requests, fail-open events, input/output characters, characters saved, and latency.
- Multi-root-aware `.codicoignore` enforcement across Codico file reads, listings, searches, writes, edits, and diagnostics, with `.copilotignore` retained for compatibility.
- Centralized workspace path/security policy shared by file tools and diagnostics.
- Paired ACCO-on / ACCO-off frozen-holdout validation and regression coverage for provider optimization behavior.

### Changed
- Agent evidence access stays available through mutation and verification instead of being hard-blocked by exploration counters.
- Stream-resume overlap verification now accepts correct recovery integration through exported wrappers while preserving the same behavioral overlap contract.
- `AgentProvider` sheds duplicated workspace-path/security logic into dedicated modules and remains below the architecture budget.
- README security, ACCO, release, and workspace-policy documentation now matches the shipped behavior.

### Security
- Browser automation now fails closed on malformed URLs and rejects non-HTTP(S) schemes such as `file:`, `data:`, `javascript:`, and `chrome:`.
- Terminal subprocesses no longer inherit the full VS Code process environment; only execution/toolchain/system variables are passed through by default.
- Workspace file access is centrally confined and multi-root aware.
- The misleading no-op `FileManager.requestPermission()` API was removed.

### Validation
- Frozen paired `stream-resume-overlap` runs produced the same 5/6 success rate with ACCO enabled and disabled; in that experiment median successful-run provider tokens fell from 1,362,844 to 672,686 with ACCO enabled.
- CI continues to cover Ubuntu, Windows, macOS, a real VS Code Extension Host, VSIX packaging, and packaged-extension smoke installation.

## 0.1.1 - 2026-10-05

### Fixed
- Chat panel was unresponsive in 0.1.0: a syntax error in the webview script left every button, input and message handler unwired.

### Added
- Regression test that parses every webview script (`chat.html` inline scripts and `media/*.js`), so a webview syntax error fails CI.
- Marketplace `AI` / `Chat` categories and search keywords.

## 0.1.0 - 2026-10-05

### Added
- Provider-native tool/function calling for OpenRouter and supported direct providers, with fenced tools retained as a compatibility fallback.
- Provider-native tool-call/result history round-tripping across iterations for OpenAI/OpenRouter, Anthropic, and Gemini.
- Automatic fallback to fenced compatibility mode when OpenRouter or a direct provider rejects native tools.
- DNS-resolved and DNS-pinned `fetch_url` protection against private-address redirects and DNS rebinding.
- Browser public-network enforcement for navigation, redirects, and subresources, with explicit `codico.browserAllowPrivateNetwork` opt-in for localhost/internal apps.
- Minimal MCP child-process environment inheritance.
- Fault/integration coverage for real SSE disconnects, native tool fragments, provider serializers, browser/DNS policy, MCP environment policy, and terminal timeout/abort behavior.
- Real VS Code Extension Host activation smoke test.
- VSIX install/list smoke test in CI and release workflows.
- VSIX packaging on pull requests plus tag/manual release automation for GitHub Releases, Visual Studio Marketplace, and Open VSX.

### Changed
- Secure URL fetching, terminal process lifecycle, MCP environment policy, provider conversation serialization, workspace diagnostics, agent history mutation, Markdown rendering, and stream notice rendering are split out of the main provider/webview monoliths.
- Codico package version moves from prototype `0.0.1` to release candidate `0.1.0`.
