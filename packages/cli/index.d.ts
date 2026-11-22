export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';
export type CliPermission = 'read' | 'edits' | 'all';
export type ChatMessage = { role: AgentRole; content: string | Array<{type: string; text?: string; image_url?: {url:string}}>; [key: string]: unknown };
export interface StandaloneEvent { type: 'text' | 'toolStart' | 'toolResult' | 'usage' | 'thinking'; text?: string; tool?: string; ok?: boolean; promptTokens?: number; completionTokens?: number }
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
}
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
export declare class StdioMcp { constructor(workspace:string,approve:(kind:'write'|'command',description:string)=>Promise<boolean>); readonly tools:Array<{server:string;name:string;description:string}>; connect(configs:Array<{name:string;command:string;args:string[];env:Record<string,string>}>):Promise<string[]>; close():void; }
export declare class CliBrowser { constructor(approve:(kind:'write'|'command',description:string)=>Promise<boolean>, executablePath?:string); close():Promise<void>; }
export declare function loadMcpConfig(workspace:string, explicit?:string):Array<{name:string;command:string;args:string[];env:Record<string,string>}>;
export declare function parseCliArgs(args:string[]):Record<string,unknown>;
export declare function main(args:string[]):Promise<number>;
export declare const HELP:string;
export declare const CLI_SYSTEM_PROMPT:string;
export declare class CliWeb { constructor(approve:(kind:'write'|'command',description:string)=>Promise<boolean>); }
