# Changelog

All notable changes to Codico will be documented in this file.

## Unreleased

### Added
- Provider-native tool/function calling for OpenRouter and supported direct providers, with fenced tools retained as a compatibility fallback.
- DNS-resolved and DNS-pinned `fetch_url` protection against private-address redirects and DNS rebinding.
- Minimal MCP child-process environment inheritance.
- CI fault/integration coverage for native tool fragments, DNS policy, MCP environment policy, and terminal timeout/abort behavior.
- VSIX packaging on pull requests plus tag/manual release automation for GitHub Releases, Visual Studio Marketplace, and Open VSX.

### Changed
- Secure URL fetching, terminal process lifecycle, MCP environment policy, and webview Markdown rendering are split out of the main provider/webview monoliths.
