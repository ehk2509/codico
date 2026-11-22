export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';
export type CliPermission = 'read' | 'edits' | 'all';
export type ChatMessage = { role: AgentRole; content: string | Array<{type: string; text?: string; image_url?: {url:string}}>; [key: string]: unknown };
/** `delta` streams visible model text as it arrives; `text` is the complete visible text of one model reply. */
export interface StandaloneEvent { type: 'text' | 'delta' | 'toolStart' | 'toolResult' | 'usage' | 'thinking'; text?: string; tool?: string; ok?: boolean; promptTokens?: number; completionTokens?: number }
export interface StandaloneConfig {
  cwd: string;
  model: string;
  permissions?: CliPermission;
  approve?: (kind: 'write' | 'command', description: string) => Promise<boolean>;
  maxSteps?: number;
  ollamaUrl?: string;
  onEvent?: (event: StandaloneEvent) => void;
  project?: ProjectContext;
  mcp?: StdioMcp;
  browser?: CliBrowser;
  web?: CliWeb;
  allowDelegation?: boolean;
}
export declare class StandaloneAgent {
  constructor(config: StandaloneConfig);
  readonly history: ChatMessage[];
  readonly workspace: NodeWorkspace;
  run(prompt: string, signal?: AbortSignal): Promise<string>;
  runStream(prompt: string, signal?: AbortSignal): AsyncIterable<StandaloneEvent>;
}
export declare function createCodicoAgent(config: StandaloneConfig): StandaloneAgent;
export declare class NodeWorkspace {
  constructor(cwd:string, permissions?:CliPermission, approve?:(kind:'write'|'command',description:string)=>Promise<boolean>);
  readonly cwd: string;
  resolve(filepath:string):string;
}
export interface SavedSession {
  version: 1; id:string; workspace:string; model:string; updatedAt:string; history:ChatMessage[];
}
export declare class SessionStore {
  constructor(workspace:string,baseDir?:string);
  readonly root:string; readonly workspace:string;
  create(model:string):SavedSession;
  save(session:SavedSession):void;
  load(id:string):SavedSession;
  list():Array<{id:string;model:string;updatedAt:string}>;
  latest():SavedSession|undefined;
  remove(id:string):void;
}
export declare class ProjectContext { constructor(workspace:string); readonly preamble:string; expand(request:string):string; }
export declare class StdioMcp { constructor(workspace:string,approve:(kind:'write'|'command',description:string)=>Promise<boolean>); readonly tools:Array<{server:string;name:string;description:string}>; connect(configs:Array<{name:string;command:string;args:string[];env:Record<string,string>}>):Promise<string[]>; close():Promise<void>; }
export declare class CliBrowser { constructor(approve:(kind:'write'|'command',description:string)=>Promise<boolean>, executablePath?:string, allowPrivateNetwork?:boolean); close():Promise<void>; }
export declare function loadMcpConfig(workspace:string, explicit?:string):Array<{name:string;command:string;args:string[];env:Record<string,string>}>;
export declare function parseCliArgs(args:string[]):Record<string,unknown>;
export declare function main(args:string[]):Promise<number>;
export declare const HELP:string;
export declare const CLI_SYSTEM_PROMPT:string;
export declare class CliWeb { constructor(approve:(kind:'write'|'command',description:string)=>Promise<boolean>); }

export interface Paint { enabled: boolean; [style: string]: unknown }
export declare function painter(enabled: boolean): Paint;
export declare function detectColor(stream?: { isTTY?: boolean }, env?: Record<string, string | undefined>): boolean;
export declare function stripAnsi(text: string): string;
export declare function sanitize(text: string): string;
/** Renders StandaloneEvents as Codico's terminal transcript (spinner, tool lines, streamed markdown). */
export declare class TranscriptRenderer {
  constructor(out: { write(text: string): unknown; isTTY?: boolean; columns?: number }, err: { write(text: string): unknown; isTTY?: boolean; columns?: number }, paint: Paint, toolNames: ReadonlySet<string>, verbose?: boolean);
  verbose: boolean;
  readonly totals: { promptTokens: number; completionTokens: number; turns: number };
  beginTurn(): void;
  handle(event: StandaloneEvent): void;
  endTurn(outcome: 'done' | 'stopped' | 'failed', message?: string): void;
}
export declare class MarkdownStream {
  constructor(paint: Paint, width: () => number, write: (text: string) => void, toolNames?: ReadonlySet<string>);
  readonly wrote: boolean;
  push(delta: string): void;
  end(): void;
}
export declare function colorDiff(text: string, paint: Paint, maxLines?: number): string;
export declare function toolLabel(tool: string): string;
export declare function summarizeResult(tool: string, text: string, ok: boolean): { summary: string; preview: string[] };
export declare function attachMentions(prompt: string, workspace: NodeWorkspace, signal: AbortSignal): Promise<{ prompt: string; attached: string[]; failed: string[] }>;
export interface UserConfig { model?: string; ollamaUrl?: string; maxSteps?: number; verbose?: boolean }
export declare function loadUserConfig(file?: string): { config: UserConfig; warning?: string };
export declare function setUserConfig(key: string, value: string | undefined, file?: string): UserConfig;
export declare function runDoctor(model: string, ollamaUrl: string, cwd: string): Promise<Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail: string }>>;
