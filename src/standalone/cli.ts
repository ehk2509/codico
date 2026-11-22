/** Fully standalone, portable terminal and one-shot CLI; does not initialize VS Code. */
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { StandaloneAgent, StandaloneEvent } from './agent';
import type { CliPermission } from './nodeWorkspace';
import { SessionStore, SavedSession } from './sessions';
import { ProjectContext } from './projectContext';
import { StdioMcp, loadMcpConfig } from './mcp';
import { CliBrowser } from './browser';
import { CliWeb } from './web';
import { PLAN_PROMPT, REVIEW_PROMPT } from '../agentPrompts';

export const HELP = [
'Codico CLI — Windows, macOS, Linux (Node.js 20+, no VS Code required)',
'',
'Usage:',
'  codico                            Start an interactive terminal session',
'  codico chat [options]             Interactive agent',
'  codico agent "<task>" [options]   One-shot agent task for CI/scripts',
'  codico run "<task>" [options]     One-shot alias in the npm CLI',
'',
'Options:',
'  --cwd <directory>                 Workspace (default: current directory)',
'  --model <id>                      ollama/model, direct:provider/model, OpenRouter,',
'                                    claude-code/opus or chatgpt/model',
'  --ollama-url <url>                Local OpenAI-compatible endpoint',
'  --allow-edits                     Ask before writing files',
'  --allow-commands                  Ask before shell commands and diagnostics',
'  --allow-mcp                       Opt in to executing configured MCP servers',
'  --mcp-config <file>               Alternate .mcp.json config (requires --allow-mcp)',
'  --allow-browser                   Enable Playwright browser tools',
'  --allow-web                       Enable external web fetch/search tools',
'  --browser-path <file>             Installed Chromium/Chrome executable',
'  --browser-local                   Permit browser access to localhost/private sites',
'  --yes                             Grant all permitted approval requests (unsafe)',
'  --max-steps <n>                   Max requests per turn (1-100)',
'  --resume <id|last>                Resume a saved workspace session',
'  --no-session                      Do not persist conversation',
'  --json                            JSONL events (one-shot only)',
'  -h, --help                        Show help',
'',
'Chat commands: /help /sessions /resume [id|last] /new /clear /model <id>',
'               /skills /mcp /plan <task> /review <task> /exit',
'',
'Project instructions: AGENTS.md, .codico/instructions.md and .codico/agents|skills.',
'MCP startup and calls require approval, independent of file/shell permissions.',
'Browser navigation and interactions require approval; commands are not sandboxed.',
'Authenticated CLI providers use CODICO_CLAUDE_PATH and CODICO_CODEX_PATH if set.',
'Legacy editor-backed commands "codico run" and "codico automate" are unchanged.',
''
].join('\n');

export interface CliOptions {
    mode:'chat'|'agent';
    prompt:string;
    cwd:string;
    model:string;
    modelExplicit:boolean;
    permissions:CliPermission;
    yes:boolean;
    maxSteps:number;
    ollamaUrl:string;
    json:boolean;
    help:boolean;
    resume?:string;
    noSession:boolean;
    allowMcp:boolean;
    mcpConfig?:string;
    allowBrowser:boolean;
    allowWeb:boolean;
    browserLocal:boolean;
    browserPath?:string;
}

export function parseCliArgs(argv:string[]):CliOptions {
    const args=[...argv];
    const mode=args[0]==='agent'||args[0]==='run'?'agent':'chat';
    if(args[0]==='agent'||args[0]==='chat'||args[0]==='run'){args.shift();}
    const opts:CliOptions={
        mode,prompt:'',cwd:process.cwd(),model:process.env.CODICO_MODEL||'ollama/qwen2.5-coder:7b',
        modelExplicit:false,permissions:'read',yes:false,maxSteps:20,ollamaUrl:'http://localhost:11434',
        json:false,help:false,noSession:false,allowMcp:false,allowBrowser:false,allowWeb:false,browserLocal:false,
    };
    const parts:string[]=[];
    for(let i=0;i<args.length;i++){
        const a=args[i];
        const value=():string=>{
            const v=args[++i];
            if(!v||v.startsWith('--')){throw new Error(a+' requires a value');}
            return v;
        };
        switch(a){
            case '-h':case '--help':opts.help=true;break;
            case '--cwd':opts.cwd=path.resolve(value());break;
            case '--model':opts.model=value();opts.modelExplicit=true;break;
            case '--ollama-url':opts.ollamaUrl=value();break;
            case '--max-steps':{
                const n=Number(value());
                if(!Number.isInteger(n)||n<1||n>100){throw new Error('--max-steps must be 1 to 100');}
                opts.maxSteps=n;break;
            }
            case '--resume':opts.resume=value();break;
            case '--no-session':opts.noSession=true;break;
            case '--allow-edits':if(opts.permissions==='read'){opts.permissions='edits';}break;
            case '--allow-commands':opts.permissions='all';break;
            case '--allow-mcp':opts.allowMcp=true;break;
            case '--mcp-config':opts.mcpConfig=value();break;
            case '--allow-browser':opts.allowBrowser=true;break;
            case '--browser-local':opts.browserLocal=true;break;
            case '--allow-web':opts.allowWeb=true;break;
            case '--browser-path':opts.browserPath=path.resolve(value());break;
            case '--yes':opts.yes=true;break;
            case '--json':opts.json=true;break;
            default:
                if(a.startsWith('-')){throw new Error('Unknown option '+a);}
                parts.push(a);
        }
    }
    opts.prompt=parts.join(' ').trim();
    if(mode==='agent'&&!opts.prompt&&!opts.help){throw new Error('codico agent requires a task');}
    if(mode==='chat'&&parts.length){throw new Error('Unexpected text; use codico agent "<task>" for one-shot tasks');}
    if(mode==='chat'&&opts.json){throw new Error('--json is only supported with codico agent');}
    if(opts.noSession&&opts.resume){throw new Error('--resume cannot be combined with --no-session');}
    if(opts.mcpConfig&&!opts.allowMcp){throw new Error('--mcp-config requires --allow-mcp');}
    if(opts.browserLocal&&!opts.allowBrowser){throw new Error('--browser-local requires --allow-browser');}
    return opts;
}

export async function main(argv:string[]):Promise<number> {
    let opts:CliOptions;
    try{opts=parseCliArgs(argv);}catch(error){stderr.write('codico: '+String((error as Error).message)+'\n\n'+HELP);return 64;}
    if(opts.help){stdout.write(HELP);return 0;}
    const terminal=readline.createInterface({input:stdin,output:stdout,terminal:!!stdin.isTTY});
    const approve=async(kind:'write'|'command',description:string):Promise<boolean>=>{
        if(opts.yes){return true;}
        if(!stdin.isTTY){return false;}
        const answer=await terminal.question('\nCodico requests '+kind+' permission:\n'+description.slice(0,5000)+'\nAllow? [y/N] ');
        return /^(y|yes)$/i.test(answer.trim());
    };
    let browser:CliBrowser|undefined;
    let web:CliWeb|undefined;
    let mcp:StdioMcp|undefined;
    let session:SavedSession|undefined;
    let agent:StandaloneAgent|undefined;
    const event=(e:StandaloneEvent):void=>{
        if(opts.json){stdout.write(JSON.stringify(e)+'\n');return;}
        if(e.type==='text'){stdout.write('\n'+(e.text??'')+'\n');}
        else if(e.type==='toolStart'){stderr.write('  > '+e.tool+' '+(e.text??'')+'\n');}
        else if(e.type==='toolResult'&&!e.ok){stderr.write('  ! '+e.tool+': '+(e.text??'').slice(0,300)+'\n');}
    };
    try{
        const store=opts.noSession?undefined:new SessionStore(opts.cwd);
        if(opts.resume){
            if(!store){throw new Error('Session storage is disabled');}
            session=opts.resume==='last'?store.latest():store.load(opts.resume);
            if(!session){throw new Error('No previous session for this workspace');}
            if(!opts.modelExplicit){opts.model=session.model;}
        }else if(store){session=store.create(opts.model);}
        const project=new ProjectContext(opts.cwd);
        if(opts.allowMcp){
            mcp=new StdioMcp(opts.cwd,approve);
            const issues=await mcp.connect(loadMcpConfig(opts.cwd,opts.mcpConfig));
            for(const issue of issues){stderr.write('codico: '+issue+'\n');}
        }
        if(opts.allowBrowser){browser=new CliBrowser(approve,opts.browserPath??process.env.CODICO_CHROME_PATH,opts.browserLocal);}
        if(opts.allowWeb){web=new CliWeb(approve);}
        const makeAgent=():StandaloneAgent=>{
            const instance=new StandaloneAgent({
                cwd:opts.cwd,model:opts.model,permissions:opts.permissions,approve,
                maxSteps:opts.maxSteps,ollamaUrl:opts.ollamaUrl,project,mcp,browser,web,onEvent:event,
            });
            if(session){instance.history.push(...session.history);}
            return instance;
        };
        const persist=():void=>{
            if(!session||!store||!agent){return;}
            session.history=agent.history;
            session.model=opts.model;
            store.save(session);
        };
        agent=makeAgent();
        const run=async(prompt:string):Promise<void>=>{
            const controller=new AbortController();
            const stop=()=>controller.abort();
            process.on('SIGINT',stop);
            try{await agent!.run(prompt,controller.signal);}
            finally{process.removeListener('SIGINT',stop);persist();}
        };
        if(opts.mode==='agent'){
            await run(opts.prompt);
            if(opts.json&&session){stdout.write(JSON.stringify({type:'session',id:session.id})+'\n');}
            return 0;
        }
        if(!stdin.isTTY){stderr.write('codico: chat requires a TTY; use codico agent "<task>" for scripts\n');return 64;}
        stdout.write('Codico CLI | '+opts.model+' | '+opts.cwd+'\n');
        if(session){stdout.write('Session: '+session.id+'\n');}
        stdout.write('Type /help for commands, /exit to quit.\n');
        for(;;){
            let prompt:string;
            try{prompt=(await terminal.question('codico> ')).trim();}
            catch{break;}
            if(!prompt){continue;}
            if(prompt==='/exit'||prompt==='/quit'){break;}
            if(prompt==='/help'){stdout.write(HELP);continue;}
            if(prompt==='/sessions'){
                if(!store){stdout.write('Session storage disabled\n');continue;}
                for(const s of store.list().slice(0,25)){stdout.write(s.id+' '+s.model+' '+s.updatedAt+'\n');}
                continue;
            }
            if(prompt==='/skills'){
                stdout.write('Project agents: '+project.extensions.agents.map(x=>'@'+x.name).join(', ')+'\n');
                stdout.write('Project skills: '+project.extensions.skills.map(x=>'/'+x.name).join(', ')+'\n');
                continue;
            }
            if(prompt==='/mcp'){
                stdout.write('MCP tools: '+(mcp?.tools.map(x=>x.server+'/'+x.name).join(', ')||'(none)')+'\n');
                continue;
            }
            if(prompt==='/new'||prompt==='/clear'){
                if(session&&store){persist();}
                session=store?.create(opts.model);
                agent=makeAgent();
                stdout.write('Started a new conversation'+(session?' '+session.id:'')+'\n');
                continue;
            }
            if(prompt==='/resume'||prompt.startsWith('/resume ')){
                if(!store){stdout.write('Sessions disabled\n');continue;}
                const id=prompt.slice('/resume'.length).trim()||'last';
                try{
                    const restored=id==='last'?store.latest():store.load(id);
                    if(!restored){throw new Error('No sessions found');}
                    session=restored;opts.model=restored.model;agent=makeAgent();
                    stdout.write('Resumed '+restored.id+' ('+opts.model+')\n');
                }catch(error){stderr.write('codico: '+String(error)+'\n');}
                continue;
            }
            if(prompt.startsWith('/model ')){
                const model=prompt.slice(7).trim();
                if(!model){stderr.write('Give a model ID\n');continue;}
                persist();opts.model=model;session=store?.create(opts.model);
                agent=makeAgent();stdout.write('Model: '+model+' (new conversation)\n');continue;
            }
            const task=prompt.startsWith('/plan ')?PLAN_PROMPT+prompt.slice(6)
                :prompt.startsWith('/review ')?REVIEW_PROMPT+'\n\n'+prompt.slice(8):prompt;
            try{await run(task);}catch(error){stderr.write('codico: '+String((error as Error).message)+'\n');}
        }
        return 0;
    }catch(error){
        const message=error instanceof Error?error.message:String(error);
        if(opts.json){stdout.write(JSON.stringify({type:'error',message})+'\n');}
        else{stderr.write('codico: '+message+'\n');}
        return 1;
    }finally{
        await mcp?.close();
        await browser?.close();
        terminal.close();
    }
}
