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
    /** Present when the server sends its own request or notification. */
    method?: string;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

/** A tool call may legitimately run for minutes; Stop cancels it sooner. */
const TOOL_CALL_TIMEOUT_MS = 300_000;

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
            this._rejectPending(`MCP [${this.name}] process error: ${err.message}`);
        });

        // Writing to a server that has exited fails asynchronously (EPIPE); unhandled, that
        // error would take down the extension host. The 'exit' handler reports the failure.
        this._proc.stdin?.on('error', () => { /* reported through 'exit' */ });

        this._proc.on('exit', (code) => {
            this._connected = false;
            this._rl?.close();
            this._rl = null;
            this._rejectPending(`MCP [${this.name}] process exited (code ${code})`);
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

    async callTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
        if (!this._connected) {
            throw new Error(`MCP server "${this.name}" is not connected`);
        }
        const result = await this._send('tools/call', { name: toolName, arguments: args }, signal);
        return result as McpToolResult;
    }

    disconnect(): void {
        this._connected = false;
        this._rl?.close();
        this._proc?.kill();
        this._proc = null;
        this._rejectPending(`MCP [${this.name}] disconnected`);
    }

    // ── Private ──────────────────────────────────────────────────────────────

    private _onLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) { return; }
        try {
            const msg = JSON.parse(trimmed) as JsonRpcResponse;
            if (msg.id === undefined || msg.id === null) { return; } // notification — ignore
            // The server's own request (it numbers its ids independently, so they can equal ours):
            // answer it rather than mistake it for the reply to one of our calls
            if (msg.method !== undefined) {
                this._writeLine(JSON.stringify(msg.method === 'ping'
                    ? { jsonrpc: '2.0', id: msg.id, result: {} }
                    : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not supported: ${msg.method}` } }));
                return;
            }
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

    private _send(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) { reject(new Error(`MCP [${this.name}] "${method}" stopped`)); return; }
            const id = this._nextId++;
            const timeoutMs = method === 'initialize' ? 15000 : method === 'tools/call' ? TOOL_CALL_TIMEOUT_MS : 30000;
            const onAbort = (): void => {
                if (!this._pending.has(id)) { return; }
                this._pending.delete(id);
                clearTimeout(timer);
                // Tell the server too, so it can stop the work
                this._notify('notifications/cancelled', { requestId: id, reason: 'Stopped by the user' });
                reject(new Error(`MCP [${this.name}] "${method}" stopped`));
            };
            const timer = setTimeout(() => {
                if (this._pending.has(id)) {
                    this._pending.delete(id);
                    signal?.removeEventListener('abort', onAbort);
                    reject(new Error(`MCP [${this.name}] timeout waiting for "${method}"`));
                }
            }, timeoutMs);
            signal?.addEventListener('abort', onAbort, { once: true });
            this._pending.set(id, {
                resolve: (v) => { signal?.removeEventListener('abort', onAbort); resolve(v); },
                reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
                timer,
            });

            const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
            this._writeLine(JSON.stringify(msg));
        });
    }

    private _rejectPending(reason: string): void {
        for (const [, pending] of this._pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
        }
        this._pending.clear();
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
