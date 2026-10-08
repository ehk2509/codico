# Changelog

All notable changes to Codico will be documented in this file.

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
