import * as vscode from 'vscode';
import { McpClient, McpTool, McpToolResult } from './mcpClient';

export interface McpServerConfig {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

export interface McpServerStatus {
    name: string;
    connected: boolean;
    toolCount: number;
    error?: string;
}

export class McpManager {
    private _clients = new Map<string, McpClient>();

    /** Connect all servers in the config. Errors are reported as warnings, not throws. */
    async connectAll(configs: McpServerConfig[]): Promise<McpServerStatus[]> {
        const statuses: McpServerStatus[] = [];

        for (const cfg of configs) {
            // Skip duplicates
            if (this._clients.has(cfg.name)) { continue; }

            try {
                const client = new McpClient(cfg.name, cfg.command, cfg.args ?? [], cfg.env);
                await client.connect();
                this._clients.set(cfg.name, client);
                statuses.push({ name: cfg.name, connected: true, toolCount: client.tools.length });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showWarningMessage(`Codico: MCP server "${cfg.name}" failed — ${message}`);
                statuses.push({ name: cfg.name, connected: false, toolCount: 0, error: message });
            }
        }

        return statuses;
    }

    /** Disconnect and remove all servers. */
    disconnectAll(): void {
        for (const client of this._clients.values()) { client.disconnect(); }
        this._clients.clear();
    }

    /** All tools across all connected servers. */
    get allTools(): Array<{ serverName: string; tool: McpTool }> {
        const result: Array<{ serverName: string; tool: McpTool }> = [];
        for (const [serverName, client] of this._clients) {
            if (!client.connected) { continue; }
            for (const tool of client.tools) {
                result.push({ serverName, tool });
            }
        }
        return result;
    }

    /** Status snapshot for the webview UI. */
    get statusSnapshot(): McpServerStatus[] {
        return Array.from(this._clients.values()).map(c => ({
            name: c.name,
            connected: c.connected,
            toolCount: c.tools.length,
        }));
    }

    /** Invoke a tool on a specific server. */
    async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        const client = this._clients.get(serverName);
        if (!client) { throw new Error(`MCP server "${serverName}" is not loaded`); }
        return client.callTool(toolName, args);
    }

    /** True if any server is connected. */
    get hasTools(): boolean { return this.allTools.length > 0; }

    /**
     * Build the system prompt section that teaches the AI about all available MCP tools.
     */
    buildSystemPromptSection(): string {
        const tools = this.allTools;
        if (tools.length === 0) { return ''; }

        const lines: string[] = [
            '## MCP Server Tools',
            '',
            'The following tools are available from connected MCP servers.',
            'To call an MCP tool, use this exact fenced-block format:',
            '',
            '```mcp_call',
            'server: <server-name>',
            'tool: <tool-name>',
            '<param>: <value>',
            '```',
            '',
            'Notes:',
            '- Each argument goes on its own line: `param: value`.',
            '- For array or object values, write inline JSON: `items: ["a","b"]`.',
            '- Call only tools listed below — do not invent names.',
            '- After receiving the tool result, continue working without asking.',
            '',
        ];

        // Group by server
        const byServer = new Map<string, McpTool[]>();
        for (const { serverName, tool } of tools) {
            if (!byServer.has(serverName)) { byServer.set(serverName, []); }
            byServer.get(serverName)!.push(tool);
        }

        for (const [serverName, serverTools] of byServer) {
            lines.push(`### MCP Server: \`${serverName}\``);
            lines.push('');
            for (const tool of serverTools) {
                lines.push(`**${tool.name}** — ${tool.description ?? '(no description)'}`);
                const props = tool.inputSchema?.properties ?? {};
                const required = new Set(tool.inputSchema?.required ?? []);
                const paramLines = Object.entries(props).map(([k, v]) => {
                    const req = required.has(k) ? ' *(required)*' : ' *(optional)*';
                    const desc = v.description ? ` — ${v.description}` : '';
                    return `  - \`${k}\` (${v.type ?? 'any'}${req})${desc}`;
                });
                if (paramLines.length > 0) {
                    lines.push('Parameters:');
                    lines.push(...paramLines);
                } else {
                    lines.push('Parameters: *(none)*');
                }
                lines.push('');
            }
        }

        return lines.join('\n');
    }
}

/**
 * Load MCP server configs from VS Code settings and/or a `.mcp.json` workspace file.
 * Standard `.mcp.json` format (used by Claude Desktop, etc.):
 * { "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...} } } }
 */
export async function loadMcpConfigs(): Promise<McpServerConfig[]> {
    const configs: McpServerConfig[] = [];
    const seen = new Set<string>();

    // 1. VS Code settings array (codico.mcpServers)
    const settingsList = vscode.workspace
        .getConfiguration('codico')
        .get<McpServerConfig[]>('mcpServers', []);
    for (const cfg of settingsList) {
        if (cfg.name && cfg.command && !seen.has(cfg.name)) {
            configs.push(cfg);
            seen.add(cfg.name);
        }
    }

    // 2. .mcp.json / mcp.json in workspace root
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        const candidates = [
            vscode.Uri.joinPath(folders[0].uri, '.mcp.json'),
            vscode.Uri.joinPath(folders[0].uri, 'mcp.json'),
        ];
        for (const uri of candidates) {
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                const json = JSON.parse(new TextDecoder().decode(bytes)) as {
                    mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
                };
                if (json.mcpServers && typeof json.mcpServers === 'object') {
                    for (const [name, cfg] of Object.entries(json.mcpServers)) {
                        if (!seen.has(name) && cfg.command) {
                            configs.push({ name, command: cfg.command, args: cfg.args ?? [], env: cfg.env });
                            seen.add(name);
                        }
                    }
                }
                break; // stop at first found
            } catch {
                // File doesn't exist — try next
            }
        }
    }

    return configs;
}
