/** Portable stdio MCP client; subprocess execution is explicitly gated by CLI permissions. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import * as readline from 'node:readline';
import { buildMcpEnvironment } from '../mcpEnvironment';
import { wrapUntrusted } from '../untrustedContent';
import type { CliApproval } from './nodeWorkspace';

export interface StdioServerConfig { name: string; command: string; args: string[]; env: Record<string,string> }
export interface StdioMcpTool {
    server: string;
    name: string;
    description: string;
    inputSchema: Record<string,unknown>;
}
type Pending = { resolve: (v: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void };

function decodeConfigs(filename: string): StdioServerConfig[] {
    if (!fs.lstatSync(filename).isFile()) { throw new Error('MCP configuration must be a regular file'); }
    const raw = fs.readFileSync(filename, 'utf8');
    if (raw.length > 100_000) { throw new Error('MCP configuration too large'); }
    const object = JSON.parse(raw) as { mcpServers?: Record<string,unknown> };
    if (!object.mcpServers || typeof object.mcpServers !== 'object' || Array.isArray(object.mcpServers)) {
        throw new Error('MCP configuration needs an mcpServers object');
    }
    const result: StdioServerConfig[] = [];
    for (const [name, value] of Object.entries(object.mcpServers).slice(0, 20)) {
        if (!value || typeof value !== 'object' || !/^[\w.-]{1,64}$/.test(name)) { throw new Error('Invalid MCP server name: ' + name); }
        const cfg = value as Record<string,unknown>;
        if (typeof cfg.command !== 'string' || !cfg.command.trim() ||
            (cfg.args !== undefined && (!Array.isArray(cfg.args) || !cfg.args.every(a => typeof a === 'string'))) ||
            (cfg.env !== undefined && (typeof cfg.env !== 'object' || !cfg.env || Array.isArray(cfg.env) ||
                !Object.values(cfg.env).every(x => typeof x === 'string')))) {
            throw new Error('Invalid MCP server configuration for ' + name);
        }
        const env: Record<string,string> = {};
        for (const [key, val] of Object.entries(cfg.env as Record<string,string> | undefined ?? {})) {
            env[key] = val.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, variable: string) => process.env[variable] ?? '');
        }
        result.push({ name, command: cfg.command, args: (cfg.args as string[] | undefined) ?? [], env });
    }
    return result;
}

export function loadMcpConfig(workspace: string, explicit?: string): StdioServerConfig[] {
    const file = explicit ? path.resolve(explicit) : ['.mcp.json','mcp.json'].map(f => path.join(workspace, f)).find(f => fs.existsSync(f));
    return file ? decodeConfigs(file) : [];
}

class Connection {
    private proc: cp.ChildProcessWithoutNullStreams | undefined;
    private id = 0;
    private readonly pending = new Map<number,Pending>();
    tools: StdioMcpTool[] = [];

    constructor(readonly cfg: StdioServerConfig, private readonly cwd: string) {}

    private clear(error: Error): void {
        for (const [id, p] of this.pending) {
            this.pending.delete(id); clearTimeout(p.timer); p.cleanup(); p.reject(error);
        }
    }
    private line(raw: string): void {
        if (raw.length > 2_000_000) { return; }
        let msg: Record<string,unknown>;
        try { msg = JSON.parse(raw) as Record<string,unknown>; } catch { return; }
        if (msg.method && msg.id !== undefined) {
            this.proc?.stdin.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'Unsupported server request'}}) + '\n');
            return;
        }
        if (typeof msg.id !== 'number') { return; }
        const pending = this.pending.get(msg.id);
        if (!pending) { return; }
        this.pending.delete(msg.id); clearTimeout(pending.timer); pending.cleanup();
        if (msg.error) { pending.reject(new Error('MCP response error: ' + JSON.stringify(msg.error).slice(0,600))); }
        else { pending.resolve(msg.result); }
    }
    private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
        if (!this.proc || this.proc.exitCode !== null || signal?.aborted) { return Promise.reject(new Error('MCP server not running')); }
        const id = ++this.id;
        return new Promise((resolve,reject) => {
            const cleanup = () => signal?.removeEventListener('abort', onAbort);
            const onAbort = () => {
                const active = this.pending.get(id);
                if (active) {
                    this.pending.delete(id); clearTimeout(active.timer); cleanup();
                    this.proc?.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id,reason:'user cancelled'}})+'\n');
                    reject(new Error('MCP request aborted'));
                }
            };
            const timer = setTimeout(() => {
                this.pending.delete(id); cleanup(); reject(new Error('MCP timeout: '+method));
            }, method === 'tools/call' ? 120_000 : 15_000);
            this.pending.set(id,{resolve,reject,timer,cleanup});
            signal?.addEventListener('abort',onAbort,{once:true});
            this.proc!.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n', err => {
                if (err) { const p=this.pending.get(id); if(p){ this.pending.delete(id); clearTimeout(p.timer);p.cleanup();p.reject(err);} }
            });
        });
    }
    async connect(): Promise<void> {
        const env=buildMcpEnvironment(this.cfg.env);
        let command=this.cfg.command;
        let args=this.cfg.args;
        if (process.platform === 'win32') {
            // npm/npx on Windows are .cmd shims, which cannot be spawned directly.
            // Start the canonical JavaScript entrypoint with Node instead of shell:true.
            const name=path.basename(command).toLowerCase().replace(/\.cmd$/, '');
            if (name==='npm'||name==='npx') {
                const script=path.join(path.dirname(process.execPath),'node_modules','npm','bin',
                    name==='npm'?'npm-cli.js':'npx-cli.js');
                if (!fs.existsSync(script)) { throw new Error('Could not locate the Windows npm launcher: '+script); }
                command=process.execPath;
                args=[script,...args];
            } else if (/\.cmd$/i.test(command)) {
                throw new Error('Windows .cmd MCP launchers are unsupported; configure node with its JavaScript script path');
            }
        }
        this.proc=cp.spawn(command,args,{cwd:this.cwd,env,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});
        this.proc.on('error',err=>this.clear(err));
        this.proc.on('exit',(code)=>this.clear(new Error('MCP exited with code '+code)));
        this.proc.stdin.on('error',()=>{});
        this.proc.stderr.resume();
        const rl=readline.createInterface({input:this.proc.stdout});
        rl.on('line',line=>this.line(line));
        const init=await this.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'codico-cli',version:'1.0.0'}});
        if (!init || typeof init !== 'object') { throw new Error('Invalid MCP initialization'); }
        this.proc.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized',params:{}})+'\n');
        const listed=await this.request('tools/list',{}) as {tools?:unknown};
        if (!Array.isArray(listed?.tools)) { throw new Error('MCP tools/list response missing tools'); }
        this.tools=listed.tools.slice(0,100).filter((t):t is {name:string;description?:string;inputSchema?:Record<string,unknown>}=>
            !!t && typeof t==='object' && typeof t.name==='string').map(t=>({
            server:this.cfg.name,name:t.name,description:t.description??'',inputSchema:t.inputSchema??{type:'object',properties:{}}
        }));
    }
    async call(name:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<string> {
        const value=await this.request('tools/call',{name,arguments:args},signal) as {content?:Array<{type?:string;text?:string}>;isError?:boolean};
        const data=(value.content??[]).filter(x=>x.type==='text').map(x=>x.text??'').join('\n').slice(0,12000);
        return (value.isError ? '[MCP tool error]\n' : '')+wrapUntrusted('MCP '+this.cfg.name+'/'+name,data);
    }
    async close():Promise<void> {
        const proc=this.proc;
        this.proc=undefined;
        this.clear(new Error('MCP connection closed'));
        if (!proc || proc.exitCode !== null) { return; }
        await new Promise<void>(resolve => {
            let finished=false;
            const done=()=>{if(finished)return;finished=true;clearTimeout(timer);resolve();};
            proc.once('exit',done);
            const timer=setTimeout(()=>{proc.kill('SIGKILL');done();},1500);
            if (!proc.kill()) {done();}
        });
    }
}

export class StdioMcp {
    private readonly connections=new Map<string,Connection>();
    readonly tools:StdioMcpTool[]=[];
    constructor(private readonly workspace:string,private readonly approve:CliApproval) {}

    async connect(configs:StdioServerConfig[]):Promise<string[]> {
        const issues:string[]=[];
        for(const cfg of configs){
            if (this.connections.has(cfg.name)) { continue; }
            const accepted=await this.approve('command','Start MCP server '+cfg.name+': '+cfg.command+' '+cfg.args.join(' '));
            if (!accepted){issues.push('MCP server '+cfg.name+' not approved');continue;}
            const c=new Connection(cfg,this.workspace);
            try {await c.connect();this.connections.set(cfg.name,c);this.tools.push(...c.tools);}
            catch(error){await c.close();issues.push('MCP '+cfg.name+': '+String(error));}
        }
        return issues;
    }

    get prompt():string {
        if (!this.tools.length) {return '';}
        return 'Connected MCP tools (call with mcp_call using server, tool, args JSON object):\n'+
            this.tools.map(t=>'- '+t.server+'/'+t.name+': '+t.description.slice(0,160)+' '+JSON.stringify(t.inputSchema).slice(0,900)).join('\n');
    }
    async call(server:string,tool:string,args:Record<string,unknown>,signal:AbortSignal):Promise<string> {
        const conn=this.connections.get(server);
        if (!conn || !this.tools.some(t=>t.server===server && t.name===tool)){return 'MCP tool not connected: '+server+'/'+tool;}
        if (!await this.approve('command','Call MCP tool '+server+'/'+tool+' with '+JSON.stringify(args).slice(0,1500))) {
            return 'Denied: MCP tool request not approved';
        }
        return conn.call(tool,args,signal);
    }
    async close():Promise<void> {
        await Promise.all([...this.connections.values()].map(c=>c.close()));
        this.connections.clear();this.tools.length=0;
    }
}
