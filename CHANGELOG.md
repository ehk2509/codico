# Changelog

All notable changes to Codico will be documented in this file.

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
