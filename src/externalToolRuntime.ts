import * as vscode from 'vscode';
import * as path from 'path';
import { BrowserManager } from './browserManager';
import { McpManager } from './mcpManager';
import {
    BrowserNavigateTool, BrowserClickTool, BrowserTypeTool, BrowserGetTextTool,
    FetchUrlTool, GetDiagnosticsTool, McpCallTool, LspSymbolTool, DebugGetVariablesTool,
} from './toolParser';
import { fetchPublicText } from './urlFetcher';
import { resolveSymbol } from './symbolProvider';
import { ExtensionMessage } from './chatProtocol';

/**
 * Owns tools whose effects cross the core workspace file/terminal boundary:
 * browser automation, public HTTP fetches, MCP, LSP diagnostics/symbols and DAP.
 *
 * Keeping these handlers outside AgentProvider makes the agent loop an orchestrator
 * instead of the implementation home for every tool family.
 */
export class ExternalToolRuntime {
    private readonly _browser = new BrowserManager();
    private _allowAllExternal = false;

    constructor(
        private readonly _mcp: McpManager,
        private readonly _post: (message: ExtensionMessage) => void,
    ) {}

    public resetTurnPermissions(): void {
        this._allowAllExternal = false;
    }

    public setAllowPrivateNetwork(allow: boolean): void {
        this._browser.setAllowPrivateNetwork(allow);
    }

    public async closeBrowser(): Promise<void> {
        await this._browser.close();
    }

    private async _confirmExternalAction(action: string, detail: string): Promise<boolean> {
        if (this._allowAllExternal) { return true; }

        const choice = await vscode.window.showWarningMessage(
            `Codico wants to ${action}.`,
            {
                modal: true,
                detail: `${detail}\n\nThis action can affect systems outside the current workspace.`,
            },
            'Allow Once',
            'Allow External Actions This Turn'
        );

        if (choice === 'Allow External Actions This Turn') {
            this._allowAllExternal = true;
            return true;
        }
        return choice === 'Allow Once';
    }

    public async _handleBrowserNavigate(tool: BrowserNavigateTool, msgId: string): Promise<string> {
        if (!await this._confirmExternalAction('navigate the browser', tool.url)) {
            return `[browser_navigate: ${tool.url}] Denied by user`;
        }
        try {
            const result = await this._browser.navigate(tool.url);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_navigate', label: result.title || tool.url, success: true });
            // Take and send a screenshot automatically after navigation
            await this._sendBrowserScreenshot(msgId).catch(() => null);
            return `[browser_navigate] ${result.text}. Page title: "${result.title}"\nCurrent URL: ${result.currentUrl}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_navigate', label: tool.url, success: false, error: message });
            return `[browser_navigate: ${tool.url}] ERROR: ${message}`;
        }
    }

    public async _handleBrowserClick(tool: BrowserClickTool, msgId: string): Promise<string> {
        if (!await this._confirmExternalAction('click in the browser', tool.selector)) {
            return `[browser_click: ${tool.selector}] Denied by user`;
        }
        try {
            const result = await this._browser.click(tool.selector);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_click', label: tool.selector, success: true });
            await this._sendBrowserScreenshot(msgId).catch(() => null);
            return `[browser_click] ${result}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_click', label: tool.selector, success: false, error: message });
            return `[browser_click: ${tool.selector}] ERROR: ${message}`;
        }
    }

    public async _handleBrowserType(tool: BrowserTypeTool, msgId: string): Promise<string> {
        const preview = tool.text.length > 120 ? tool.text.slice(0, 120) + '…' : tool.text;
        if (!await this._confirmExternalAction('type into the browser', `${tool.selector} → "${preview}"`)) {
            return `[browser_type: ${tool.selector}] Denied by user`;
        }
        try {
            const result = await this._browser.typeText(tool.selector, tool.text, tool.submit ?? false);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_type', label: `${tool.selector} → "${tool.text}"`, success: true });
            await this._sendBrowserScreenshot(msgId).catch(() => null);
            return `[browser_type] ${result}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_type', label: tool.selector, success: false, error: message });
            return `[browser_type: ${tool.selector}] ERROR: ${message}`;
        }
    }

    public async _handleBrowserGetText(tool: BrowserGetTextTool, msgId: string): Promise<string> {
        try {
            const text = await this._browser.getText(tool.selector);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_get_text', label: tool.selector ?? 'page', success: true });
            return `[browser_get_text: ${tool.selector ?? 'page'}]\n${text}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_get_text', label: tool.selector ?? 'page', success: false, error: message });
            return `[browser_get_text] ERROR: ${message}`;
        }
    }

    public async _handleBrowserScreenshot(msgId: string): Promise<string> {
        try {
            await this._sendBrowserScreenshot(msgId);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_screenshot', label: 'screenshot', success: true });
            return `[browser_screenshot] Screenshot captured and displayed in chat.`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_screenshot', label: 'screenshot', success: false, error: message });
            return `[browser_screenshot] ERROR: ${message}`;
        }
    }

    private async _sendBrowserScreenshot(msgId: string): Promise<void> {
        const buf = await this._browser.screenshot();
        const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
        this._post({ type: 'browserScreenshot', id: msgId, dataUrl, url: this._browser.currentUrl });
    }

    public async _handleFetchUrl(tool: FetchUrlTool, msgId: string): Promise<string> {
        if (!await this._confirmExternalAction('fetch a URL', tool.url)) {
            return `[fetch_url: ${tool.url}] Denied by user`;
        }

        try {
            const text = await fetchPublicText(tool.url);
            this._post({ type: 'toolResult', id: msgId, tool: 'fetch_url', label: tool.url, success: true });
            return `[fetch_url: ${tool.url}]\n${text}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'fetch_url', label: tool.url, success: false, error: message });
            return `[fetch_url: ${tool.url}] ERROR: ${message}`;
        }
    }

    public async _handleGetDiagnostics(tool: GetDiagnosticsTool, msgId: string): Promise<string> {
        try {
            let pairs: [vscode.Uri, readonly vscode.Diagnostic[]][];

            if (tool.filepath) {
                const folders = vscode.workspace.workspaceFolders;
                if (!folders || folders.length === 0) {
                    this._post({ type: 'toolResult', id: msgId, tool: 'get_diagnostics', label: 'workspace', success: false, error: 'No workspace folder open' });
                    return '[get_diagnostics] ERROR: No workspace folder open';
                }
                const normalized = path.posix.normalize(tool.filepath.replace(/\\/g, '/'));
                if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
                    this._post({ type: 'toolResult', id: msgId, tool: 'get_diagnostics', label: tool.filepath, success: false, error: 'Unsafe path rejected' });
                    return `[get_diagnostics: ${tool.filepath}] ERROR: Unsafe path rejected`;
                }
                const fileUri = vscode.Uri.joinPath(folders[0].uri, normalized);
                pairs = [[fileUri, vscode.languages.getDiagnostics(fileUri)]];
            } else {
                pairs = vscode.languages.getDiagnostics();
            }

            const lines: string[] = [];
            let count = 0;
            for (const [uri, diags] of pairs) {
                const relPath = vscode.workspace.asRelativePath(uri);
                for (const d of diags) {
                    if (count >= 50) { lines.push('… (truncated at 50)'); break; }
                    const sev = ['🔴 ERROR', '⚠️ WARN', 'ℹ️ INFO', '💡 HINT'][d.severity] ?? 'DIAG';
                    lines.push(`${relPath}:${d.range.start.line + 1}:${d.range.start.character + 1}: ${sev}: ${d.message}`);
                    count++;
                }
                if (count >= 50) { break; }
            }

            const label = tool.filepath ?? 'workspace';
            this._post({ type: 'toolResult', id: msgId, tool: 'get_diagnostics', label, success: true });
            return lines.length === 0
                ? `[get_diagnostics: ${label}] No diagnostics — workspace is clean!`
                : `[get_diagnostics: ${label}]\n${lines.join('\n')}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'get_diagnostics', label: tool.filepath ?? 'workspace', success: false, error: message });
            return `[get_diagnostics] ERROR: ${message}`;
        }
    }

    public async _handleMcpCall(tool: McpCallTool, msgId: string): Promise<string> {
        const label = `${tool.server}/${tool.tool}`;
        if (!await this._confirmExternalAction('call an MCP tool', label)) {
            return `[mcp_call: ${label}] Denied by user`;
        }
        try {
            const result = await this._mcp.callTool(tool.server, tool.tool, tool.args);
            // Flatten content parts to a single string
            const text = (result.content ?? [])
                .map(part => {
                    if (part.type === 'text') { return part.text ?? ''; }
                    if (part.type === 'image') { return `[image: ${part.mimeType ?? 'unknown'}]`; }
                    return `[${part.type}]`;
                })
                .join('\n');
            const isError = result.isError === true;
            this._post({ type: 'toolResult', id: msgId, tool: 'mcp_call', label, success: !isError, error: isError ? text : undefined });
            return isError
                ? `[mcp_call: ${label}] ERROR:\n${text}`
                : `[mcp_call: ${label}]\n${text}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'mcp_call', label, success: false, error: message });
            return `[mcp_call: ${label}] ERROR: ${message}`;
        }
    }

    public async _handleLspSymbol(tool: LspSymbolTool, msgId: string): Promise<string> {
        const label = `lsp: ${tool.query}`;
        try {
            const symbols = await resolveSymbol(tool.query, 8);
            if (symbols.length === 0) {
                this._post({ type: 'toolResult', id: msgId, tool: 'lsp_symbol', label, success: true });
                return `[lsp_symbol: "${tool.query}"] No symbols found.`;
            }
            const lines = symbols.map(s => {
                const parts = [`### ${s.kind} \`${s.name}\`  —  ${s.definedIn}:${s.definedAtLine}`];
                if (s.typeInfo) { parts.push(s.typeInfo); }
                if (s.definitionSnippet) { parts.push(`\`\`\`\n${s.definitionSnippet}\n\`\`\``); }
                return parts.join('\n');
            });
            this._post({ type: 'toolResult', id: msgId, tool: 'lsp_symbol', label, success: true });
            return `[lsp_symbol: "${tool.query}"]\n${lines.join('\n\n')}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'lsp_symbol', label, success: false, error: message });
            return `[lsp_symbol: "${tool.query}"] ERROR: ${message}`;
        }
    }

    // ── Debug tools ───────────────────────────────────────────────────────────

    public async _handleDebugGetVariables(tool: DebugGetVariablesTool, msgId: string): Promise<string> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            this._post({ type: 'toolResult', id: msgId, tool: 'debug_get_variables', label: 'variables', success: false, error: 'No active debug session' });
            return '[debug_get_variables] No active debug session. Start a debug session first.';
        }

        try {
            // Get stack frames for the current thread
            const threadsResp = await session.customRequest('threads', {}) as { threads: Array<{ id: number; name: string }> };
            if (!threadsResp.threads || threadsResp.threads.length === 0) {
                this._post({ type: 'toolResult', id: msgId, tool: 'debug_get_variables', label: 'variables', success: false, error: 'No threads' });
                return '[debug_get_variables] No threads found in the current debug session.';
            }

            const threadId = threadsResp.threads[0].id;
            const stackResp = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 20 }) as { stackFrames: Array<{ id: number; name: string; source?: { name?: string }; line: number }> };
            const frames = stackResp.stackFrames ?? [];
            // DAP frameIds are opaque identifiers, not array indices — find by id, fall back to top frame
            const targetFrame = (tool.frameId != null ? frames.find(f => f.id === tool.frameId) : undefined) ?? frames[0];
            if (!targetFrame) {
                this._post({ type: 'toolResult', id: msgId, tool: 'debug_get_variables', label: 'variables', success: false, error: 'No stack frames' });
                return '[debug_get_variables] No stack frames available.';
            }

            // Get scopes for the selected frame
            const scopesResp = await session.customRequest('scopes', { frameId: targetFrame.id }) as { scopes: Array<{ name: string; variablesReference: number; expensive: boolean }> };
            const scopes = scopesResp.scopes ?? [];

            const lines: string[] = [`Frame: ${targetFrame.name} (${targetFrame.source?.name ?? '?'}:${targetFrame.line})`];

            for (const scope of scopes) {
                if (scope.expensive) { continue; } // skip large scopes like Globals
                const varsResp = await session.customRequest('variables', { variablesReference: scope.variablesReference }) as { variables: Array<{ name: string; value: string; type?: string; variablesReference: number }> };
                const vars = varsResp.variables ?? [];
                if (vars.length === 0) { continue; }
                lines.push(`\n[${scope.name}]`);
                for (const v of vars.slice(0, 50)) {
                    const typeTag = v.type ? ` (${v.type})` : '';
                    lines.push(`  ${v.name}${typeTag} = ${v.value}`);
                }
            }

            const output = lines.join('\n');
            this._post({ type: 'toolResult', id: msgId, tool: 'debug_get_variables', label: 'variables', success: true });
            return `[debug_get_variables]\n${output}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'debug_get_variables', label: 'variables', success: false, error: message });
            return `[debug_get_variables] ERROR: ${message}`;
        }
    }

    public async _handleDebugGetCallstack(msgId: string): Promise<string> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            this._post({ type: 'toolResult', id: msgId, tool: 'debug_get_callstack', label: 'call stack', success: false, error: 'No active debug session' });
            return '[debug_get_callstack] No active debug session.';
        }

        try {
            const threadsResp = await session.customRequest('threads', {}) as { threads: Array<{ id: number; name: string }> };
            const lines: string[] = [];

            for (const thread of threadsResp.threads ?? []) {
                lines.push(`Thread ${thread.id}: ${thread.name}`);
                const stackResp = await session.customRequest('stackTrace', { threadId: thread.id, startFrame: 0, levels: 30 }) as { stackFrames: Array<{ id: number; name: string; source?: { name?: string; path?: string }; line: number; column: number }> };
                for (let i = 0; i < (stackResp.stackFrames ?? []).length; i++) {
                    const f = stackResp.stackFrames[i];
                    const loc = f.source?.name ? `${f.source.name}:${f.line}:${f.column}` : `frame ${f.id}`;
                    lines.push(`  #${i}  ${f.name}  —  ${loc}`);
                }
            }

            const output = lines.join('\n') || '(no stack frames)';
            this._post({ type: 'toolResult', id: msgId, tool: 'debug_get_callstack', label: 'call stack', success: true });
            return `[debug_get_callstack]\n${output}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'debug_get_callstack', label: 'call stack', success: false, error: message });
            return `[debug_get_callstack] ERROR: ${message}`;
        }
    }

    public async _handleDebugListBreakpoints(msgId: string): Promise<string> {
        try {
            const breakpoints = vscode.debug.breakpoints;
            if (breakpoints.length === 0) {
                this._post({ type: 'toolResult', id: msgId, tool: 'debug_list_breakpoints', label: 'breakpoints', success: true });
                return '[debug_list_breakpoints] No breakpoints set.';
            }

            const lines: string[] = [];
            for (const bp of breakpoints) {
                if (bp instanceof vscode.SourceBreakpoint) {
                    const rel = vscode.workspace.asRelativePath(bp.location.uri);
                    const line = bp.location.range.start.line + 1;
                    const col = bp.location.range.start.character + 1;
                    const cond = bp.condition ? `  condition: ${bp.condition}` : '';
                    const hitCond = bp.hitCondition ? `  hitCondition: ${bp.hitCondition}` : '';
                    const enabled = bp.enabled ? '' : '  [DISABLED]';
                    lines.push(`${rel}:${line}:${col}${enabled}${cond}${hitCond}`);
                } else if (bp instanceof vscode.FunctionBreakpoint) {
                    const enabled = bp.enabled ? '' : '  [DISABLED]';
                    lines.push(`function: ${bp.functionName}${enabled}`);
                }
            }

            this._post({ type: 'toolResult', id: msgId, tool: 'debug_list_breakpoints', label: `${breakpoints.length} breakpoint(s)`, success: true });
            return `[debug_list_breakpoints] ${breakpoints.length} breakpoint(s):\n${lines.join('\n')}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'debug_list_breakpoints', label: 'breakpoints', success: false, error: message });
            return `[debug_list_breakpoints] ERROR: ${message}`;
        }
    }
}
