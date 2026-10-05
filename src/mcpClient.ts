import * as cp from 'child_process';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { buildMcpEnvironment } from './mcpEnvironment';

export interface McpToolSchema {
    type: string;
    properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>;
    required?: string[];
}

export interface McpTool {
    name: string;
    description?: string;
    inputSchema: McpToolSchema;
}

export interface McpContentPart {
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
}

export interface McpToolResult {
    content: McpContentPart[];
    isError?: boolean;
}

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: unknown;
}

interface JsonRpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: unknown;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

export class McpClient {
    private _proc: cp.ChildProcess | null = null;
    private _rl: readline.Interface | null = null;
    private _nextId = 1;
    private _pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    private _tools: McpTool[] = [];
    private _connected = false;

    constructor(
        public readonly name: string,
        private readonly _command: string,
        private readonly _args: string[],
        private readonly _env?: Record<string, string>
    ) {}

    get tools(): McpTool[] { return this._tools; }
    get connected(): boolean { return this._connected; }

    async connect(): Promise<void> {
        const env = buildMcpEnvironment(this._env ?? {});

        this._proc = cp.spawn(this._command, this._args, {
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
        });

        this._proc.on('error', (err) => {
            this._connected = false;
            vscode.window.showWarningMessage(`Codico MCP [${this.name}]: process error — ${err.message}`);
            // Reject all pending calls immediately so they don't time out waiting
            for (const [, pending] of this._pending) {
                clearTimeout(pending.timer);
                pending.reject(new Error(`MCP [${this.name}] process error: ${err.message}`));
            }
            this._pending.clear();
        });

        this._proc.on('exit', (code) => {
            this._connected = false;
            this._rl?.close();
            this._rl = null;
            for (const [, pending] of this._pending) {
                clearTimeout(pending.timer);
                pending.reject(new Error(`MCP [${this.name}] process exited (code ${code})`));
            }
            this._pending.clear();
        });

        this._rl = readline.createInterface({ input: this._proc.stdout! });
        this._rl.on('line', (line) => this._onLine(line));

        // Silence stderr (server diagnostics) — don't pollute the user's terminal
        this._proc.stderr?.resume();

        // MCP handshake
        await this._send('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            clientInfo: { name: 'codico', version: '1.0.0' },
        });

        this._notify('notifications/initialized', {});

        const listResult = await this._send('tools/list', {}) as { tools?: McpTool[] };
        this._tools = listResult?.tools ?? [];
        this._connected = true;
    }

    async callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        if (!this._connected) {
            throw new Error(`MCP server "${this.name}" is not connected`);
        }
        const result = await this._send('tools/call', { name: toolName, arguments: args });
        return result as McpToolResult;
    }

    disconnect(): void {
        this._connected = false;
        this._rl?.close();
        this._proc?.kill();
        this._proc = null;
    }

    // ── Private ──────────────────────────────────────────────────────────────

    private _onLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) { return; }
        try {
            const msg = JSON.parse(trimmed) as JsonRpcResponse;
            if (msg.id === undefined) { return; } // notification — ignore
            const pending = this._pending.get(msg.id);
            if (!pending) { return; }
            this._pending.delete(msg.id);
            clearTimeout(pending.timer);
            if (msg.error) {
                pending.reject(new Error(`MCP [${this.name}] ${msg.error.message}`));
            } else {
                pending.resolve(msg.result);
            }
        } catch {
            // Ignore unparseable lines (server startup banners, etc.)
        }
    }

    private _send(method: string, params: unknown): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const id = this._nextId++;
            const timeoutMs = method === 'initialize' ? 15000 : 30000;
            const timer = setTimeout(() => {
                if (this._pending.has(id)) {
                    this._pending.delete(id);
                    reject(new Error(`MCP [${this.name}] timeout waiting for "${method}"`));
                }
            }, timeoutMs);
            this._pending.set(id, { resolve, reject, timer });

            const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
            this._writeLine(JSON.stringify(msg));
        });
    }

    private _notify(method: string, params: unknown): void {
        const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
        this._writeLine(JSON.stringify(msg));
    }

    private _writeLine(line: string): void {
        if (!this._proc?.stdin) { return; }
        const ok = this._proc.stdin.write(line + '\n');
        if (!ok) {
            // Drain the stream so subsequent writes aren't blocked; log but don't throw
            this._proc.stdin.once('drain', () => { /* back-pressure cleared */ });
        }
    }
}
