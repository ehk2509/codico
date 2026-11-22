/** Fully standalone, portable terminal and one-shot CLI; does not initialize VS Code. */
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline/promises';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { stdin, stdout, stderr } from 'node:process';
import { StandaloneAgent, StandaloneEvent } from './agent';
import type { CliPermission } from './nodeWorkspace';
import type { ChatMessage } from '../openRouterClient';
import { getNativeToolDefinitions } from '../nativeTools';
import { SessionStore, SavedSession } from './sessions';
import { ProjectContext } from './projectContext';
import { StdioMcp, loadMcpConfig } from './mcp';
import { CliBrowser } from './browser';
import { CliWeb } from './web';
import { PLAN_PROMPT, REVIEW_PROMPT } from '../agentPrompts';
import { CONFIG_KEYS, configFile, loadUserConfig, setUserConfig, workspaceMode, rememberWorkspaceMode } from './config';
import { CUSTOM_MODEL, friendlyError, modelChoices, modelProblem } from './models';
import { select, SelectOptions } from './tui/select';
import { isUserRequest, userRequestText } from '../historyCompaction';
import { cliVersion, formatDoctor, runDoctor } from './doctor';
import { detectColor, painter, Paint, sanitize, SYMBOLS, displayWidth, terminalWidth, truncate } from './tui/ansi';
import { TranscriptRenderer, colorDiff, formatTokens } from './tui/renderer';
import { MutableOutput, FileIndex, appendHistory, attachMentions, completer, loadHistory } from './tui/input';

export const HELP = [
'Codico CLI — Windows, macOS, Linux (Node.js 20+, no VS Code required)',
'',
'Usage:',
'  codico                            Start an interactive terminal session',
'  codico chat [options]             Interactive agent',
'  codico agent "<task>" [options]   One-shot agent task for CI/scripts',
'  codico run "<task>" [options]     One-shot alias in the npm CLI',
'  codico doctor                     Check Node, model, keys and optional tools',
'  codico config [list|get|set|unset] [key] [value]',
'                                    User defaults in ~/.codico/config.json',
'  codico --version                  Print the version',
'',
'Options:',
'  --cwd <directory>                 Workspace (default: current directory)',
'  --model <id>                      ollama/model, direct:provider/model, OpenRouter,',
'                                    claude-code/opus or chatgpt/model',
'  --ollama-url <url>                Local OpenAI-compatible endpoint',
'  --allow-edits                     Ask before writing files',
'  --allow-commands                  Ask before shell commands and diagnostics',
'  --ask                             Ask mode: answer questions, change nothing',
'  --plan                            Plan mode: write a plan to approve before any change',
'  --auto                            Edit files and run commands without asking (trusted folders only)',
'  --allow-mcp                       Opt in to executing configured MCP servers',
'  --mcp-config <file>               Alternate .mcp.json config (requires --allow-mcp)',
'  --allow-browser                   Enable Playwright browser tools',
'  --allow-web                       Enable external web fetch/search tools',
'  --browser-path <file>             Installed Chromium/Chrome executable',
'  --browser-local                   Permit browser access to localhost/private sites',
'  --yes                             Grant all permitted approval requests (unsafe)',
'  --max-steps <n>                   Max requests per turn (1-100, default 50)',
'  --resume <id|last>                Resume a saved workspace session',
'  -c, --continue                    Resume the latest session (same as --resume last)',
'  --no-session                      Do not persist conversation',
'  --json                            JSONL events (one-shot only)',
'  --verbose                         Show full tool output',
'  --no-color                        Disable colors (NO_COLOR is also honored)',
'  -v, --version                     Print the version',
'  -h, --help                        Show help',
'',
'In the chat:',
'  @path/to/file[:10-40]             Attach a file (Tab completes paths)',
'  !<command>                        Run a shell command yourself; output joins your next message',
'  line ending with \\                Continue on the next line',
'  ctrl+c                            Interrupt the agent; twice at the prompt to quit',
'',
'Chat commands:',
'  /help /status /model [id] /mode [read|edits|all] /cost /diff /compact /init',
'  /sessions /resume [id|last] /new /clear /skills /mcp /verbose',
'  /plan <task> /review <task> /exit',
'',
'Project instructions: AGENTS.md, .codico/instructions.md and .codico/agents|skills.',
'MCP startup and calls require approval, independent of file/shell permissions.',
'Browser navigation and interactions require approval; commands are not sandboxed.',
'Authenticated CLI providers use CODICO_CLAUDE_PATH and CODICO_CODEX_PATH if set.',
'Legacy editor-backed commands "codico run" and "codico automate" are unchanged.',
''
].join('\n');

export interface CliOptions {
    mode:'chat'|'agent'|'doctor'|'config'|'version';
    prompt:string;
    cwd:string;
    model:string;
    modelExplicit:boolean;
    permissions:CliPermission;
    /** --allow-edits or --allow-commands was given. */
    permissionsExplicit:boolean;
    /** Auto mode: edits and commands run without asking. */
    auto:boolean;
    /** Plan mode: read-only, every request produces a plan to approve. */
    plan:boolean;
    yes:boolean;
    maxSteps:number;
    maxStepsExplicit:boolean;
    ollamaUrl:string;
    ollamaUrlExplicit:boolean;
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
    verbose:boolean;
    color?:boolean;
    /** Positional words for the config subcommand. */
    args:string[];
}

export const DEFAULT_MODEL='ollama/qwen2.5-coder:7b';

export function parseCliArgs(argv:string[]):CliOptions {
    const args=[...argv];
    const first=args[0];
    const mode:CliOptions['mode']=first==='agent'||first==='run'?'agent':first==='doctor'?'doctor':first==='config'?'config'
        :first==='--version'||first==='-v'?'version':'chat';
    if(['agent','chat','run','doctor','config'].includes(first)){args.shift();}
    const opts:CliOptions={
        mode,prompt:'',cwd:process.cwd(),model:process.env.CODICO_MODEL||DEFAULT_MODEL,
        modelExplicit:!!process.env.CODICO_MODEL,permissions:'read',permissionsExplicit:false,auto:false,plan:false,yes:false,maxSteps:50,maxStepsExplicit:false,
        ollamaUrl:'http://localhost:11434',ollamaUrlExplicit:false,
        json:false,help:false,noSession:false,allowMcp:false,allowBrowser:false,allowWeb:false,browserLocal:false,
        verbose:false,args:[],
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
            case '-v':case '--version':opts.mode='version';break;
            case '--cwd':opts.cwd=path.resolve(value());break;
            case '--model':opts.model=value();opts.modelExplicit=true;break;
            case '--ollama-url':opts.ollamaUrl=value();opts.ollamaUrlExplicit=true;break;
            case '--max-steps':{
                const n=Number(value());
                if(!Number.isInteger(n)||n<1||n>100){throw new Error('--max-steps must be 1 to 100');}
                opts.maxSteps=n;opts.maxStepsExplicit=true;break;
            }
            case '--resume':opts.resume=value();break;
            case '-c':case '--continue':opts.resume='last';break;
            case '--no-session':opts.noSession=true;break;
            case '--allow-edits':if(opts.permissions==='read'){opts.permissions='edits';}opts.permissionsExplicit=true;break;
            case '--allow-commands':opts.permissions='all';opts.permissionsExplicit=true;break;
            case '--allow-mcp':opts.allowMcp=true;break;
            case '--mcp-config':opts.mcpConfig=value();break;
            case '--allow-browser':opts.allowBrowser=true;break;
            case '--browser-local':opts.browserLocal=true;break;
            case '--allow-web':opts.allowWeb=true;break;
            case '--browser-path':opts.browserPath=path.resolve(value());break;
            case '--yes':opts.yes=true;break;
            case '--auto':opts.permissions='all';opts.auto=true;opts.permissionsExplicit=true;break;
            case '--ask':opts.permissions='read';opts.permissionsExplicit=true;break;
            case '--plan':opts.permissions='read';opts.plan=true;opts.permissionsExplicit=true;break;
            case '--json':opts.json=true;break;
            case '--verbose':opts.verbose=true;break;
            case '--no-color':opts.color=false;break;
            case '--color':opts.color=true;break;
            default:
                if(a.startsWith('-')&&opts.mode!=='config'){throw new Error('Unknown option '+a);}
                parts.push(a);
        }
    }
    opts.prompt=parts.join(' ').trim();
    if(opts.mode==='config'){opts.args=parts;opts.prompt='';}
    if(opts.mode==='agent'&&!opts.prompt&&!opts.help){throw new Error('codico agent requires a task');}
    if((opts.mode==='chat'||opts.mode==='doctor')&&parts.length){throw new Error('Unexpected text; use codico agent "<task>" for one-shot tasks');}
    if(opts.mode==='chat'&&opts.json){throw new Error('--json is only supported with codico agent');}
    if(opts.noSession&&opts.resume){throw new Error('--resume cannot be combined with --no-session');}
    if(opts.mcpConfig&&!opts.allowMcp){throw new Error('--mcp-config requires --allow-mcp');}
    if(opts.browserLocal&&!opts.allowBrowser){throw new Error('--browser-local requires --allow-browser');}
    return opts;
}

/**
 * Chat modes. ask and plan are read-only (enforced: the model is not given mutating tools); agent and
 * auto may edit files and run commands, auto without asking. "edits" (files, no commands) is only
 * reachable with --allow-edits or /mode edits, for scripts that want that tier.
 */
type ChatMode='ask'|'plan'|'agent'|'auto'|'edits';
const MODE_LABEL:Record<ChatMode,string>={
    ask:'Ask — answers questions about your code, changes nothing',
    plan:'Plan — writes a step-by-step plan, then you approve it',
    agent:'Agent — edits files and runs commands, asks before each one',
    auto:'Auto — agent that edits and runs commands without asking',
    edits:'Agent (files only) — edits files, asks first; no commands',
};
const MODE_TAG:Record<ChatMode,string>={ask:'ask',plan:'plan',agent:'agent',auto:'auto',edits:'agent:files'};
const MODE_ORDER:ChatMode[]=['ask','plan','agent','auto'];
const MODE_PERMISSION:Record<ChatMode,CliPermission>={ask:'read',plan:'read',agent:'all',auto:'all',edits:'edits'};
const modeOf=(o:{permissions:CliPermission;auto:boolean;plan:boolean}):ChatMode=>
    o.auto?'auto':o.plan?'plan':o.permissions==='read'?'ask':o.permissions==='edits'?'edits':'agent';
/** Saved folder choices from before the rename keep working. */
function normalizeMode(saved:string|undefined):ChatMode|undefined{
    const legacy:Record<string,ChatMode>={read:'ask',all:'agent'};
    const mode=saved?legacy[saved]??saved:undefined;
    return mode&&mode in MODE_LABEL?mode as ChatMode:undefined;
}

const EXECUTE_PLAN_PROMPT='The user approved the plan above. Carry it out now, step by step: make the changes, then verify them (run the tests or the program when there are any). Do not re-plan finished steps.';
const REVISE_PLAN_PREFIX='Revise the plan with this feedback. Same rules as before: read and search only, no changes, end with the numbered plan and the Files Affected section.\n\nFeedback: ';

/** Chat commands with a plain description; `arg` names a value the command asks for when picked from the menu. */
const COMMAND_INFO:{name:string;description:string;arg?:string}[]=[
    {name:'/model',description:'Choose the AI model'},
    {name:'/mode',description:'Switch mode: Ask, Plan, Agent or Auto'},
    {name:'/plan',description:'Plan a task (read-only), then approve it to carry it out',arg:'What should be planned?'},
    {name:'/review',description:'Review code for bugs and risks',arg:'What should be reviewed?'},
    {name:'/diff',description:'Show changes not yet committed (git)'},
    {name:'/init',description:'Write an AGENTS.md that explains this project to agents'},
    {name:'/new',description:'Start a new conversation'},
    {name:'/resume',description:'Go back to an earlier conversation'},
    {name:'/compact',description:'Summarise this conversation to free up context'},
    {name:'/status',description:'Show model, mode, session and token use'},
    {name:'/cost',description:'Show tokens used in this session'},
    {name:'/skills',description:'List this project\'s agents and skills'},
    {name:'/mcp',description:'List connected MCP tools'},
    {name:'/verbose',description:'Show or hide full tool output'},
    {name:'/help',description:'Show help'},
    {name:'/exit',description:'Quit Codico'},
];
const CHAT_COMMANDS=[...COMMAND_INFO.map(c=>c.name),'/sessions','/clear','/quit'];

function chatHelp(p:Paint):string{
    const width=Math.max(...COMMAND_INFO.map(c=>c.name.length))+2;
    return [
        '',
        p.bold('Just type what you want done, in plain words:'),
        p.gray('  "add tests for utils.ts"   "why does the build fail?"   "explain src/app.ts"'),
        '',
        p.bold('Shortcuts'),
        `  ${p.accent('@file'.padEnd(12))}attach a file (Tab completes the path)`,
        `  ${p.accent('!command'.padEnd(12))}run a command yourself; Codico sees the output`,
        `  ${p.accent('shift+tab'.padEnd(12))}switch mode: Ask → Plan → Agent → Auto`,
        `  ${p.accent('ctrl+c'.padEnd(12))}stop Codico · press twice at the prompt to quit`,
        `  ${p.accent('/'.padEnd(12))}open the command menu`,
        '',
        p.bold('Commands'),
        ...COMMAND_INFO.map(c=>`  ${p.accent(c.name.padEnd(width))}${c.description}`),
        '',
        p.gray('  Command-line options: codico --help · check your setup: codico doctor'),
        '',
    ].join('\n');
}

const INIT_PROMPT=`Analyze this repository and create (or improve, if it exists) an AGENTS.md file at its root for future coding agents.
Inspect the real files first: package manifests, build/test scripts, folder layout, lint/format config and existing docs.
AGENTS.md should be concise (under ~80 lines) and cover: what the project is, how to build, test and lint (exact commands),
the code layout, conventions that are not obvious from the code, and pitfalls. Do not invent commands you have not seen.`;

function tildify(dir:string):string{
    const home=os.homedir();
    return dir.toLowerCase().startsWith(home.toLowerCase())?'~'+dir.slice(home.length):dir;
}

function banner(p:Paint, version:string, model:string, permissions:ChatMode, cwd:string, session?:string, resumed=false):string{
    const rows:[string,string][]=[
        ['model',model.replace(/^ollama\//,'')+p.gray(model.startsWith('ollama/')?'  (on this computer)':'')],
        ['mode',permissions==='auto'?p.yellow(MODE_LABEL.auto):MODE_LABEL[permissions]],
        ['folder',tildify(cwd)],
    ];
    if(resumed&&session){rows.push(['session','continuing '+session.slice(0,8)]);}
    const title=`${p.accent('✻')} ${p.bold('Codico')} ${p.gray('v'+version)}`;
    const body=rows.map(([k,v])=>`  ${p.gray(k.padEnd(7))}${v}`);
    const width=Math.min(terminalWidth(stdout)-2,Math.max(displayWidth(title),...body.map(displayWidth))+3);
    const line=(text:string)=>p.gray('│ ')+truncate(text,width-3)+' '.repeat(Math.max(0,width-3-displayWidth(truncate(text,width-3))))+p.gray('│');
    return [p.gray('╭'+'─'.repeat(width-2)+'╮'),line(title),line(''),...body.map(line),p.gray('╰'+'─'.repeat(width-2)+'╯'),
        `  Type what you want done. ${p.accent('/')} ${p.gray('commands ·')} ${p.accent('@')} ${p.gray('attach a file ·')} ${p.accent('shift+tab')} ${p.gray('switch mode ·')} ${p.accent('/help')}`,''].join('\n')+'\n';
}

function configCommand(opts:CliOptions,p:Paint):number{
    const [action='list',key,...rest]=opts.args;
    const file=configFile();
    try{
        if(action==='list'||action==='show'){
            const {config,warning}=loadUserConfig(file);
            if(warning){stderr.write(p.yellow(warning)+'\n');}
            stdout.write(p.gray(file)+'\n');
            for(const [k,description] of Object.entries(CONFIG_KEYS)){
                const v=(config as Record<string,unknown>)[k];
                stdout.write(`  ${p.bold(k.padEnd(10))} ${v===undefined?p.gray('(unset)'):p.cyan(String(v))}  ${p.gray(description)}\n`);
            }
            return 0;
        }
        if(!key){throw new Error(`codico config ${action} needs a key`);}
        if(action==='get'){
            const v=(loadUserConfig(file).config as Record<string,unknown>)[key];
            if(v!==undefined){stdout.write(String(v)+'\n');}
            return v===undefined?1:0;
        }
        if(action==='set'){
            if(!rest.length){throw new Error('codico config set needs a value');}
            setUserConfig(key,rest.join(' '),file);
            stdout.write(p.green(SYMBOLS.check)+` ${key} = ${rest.join(' ')}\n`);
            return 0;
        }
        if(action==='unset'){
            if(!(key in CONFIG_KEYS)){throw new Error(`Unknown config key "${key}"`);}
            setUserConfig(key,undefined,file);
            stdout.write(p.green(SYMBOLS.check)+` ${key} unset\n`);
            return 0;
        }
        throw new Error(`Unknown config action "${action}" (list, get, set, unset)`);
    }catch(error){stderr.write('codico: '+(error as Error).message+'\n');return 64;}
}

export async function main(argv:string[]):Promise<number> {
    let opts:CliOptions;
    try{opts=parseCliArgs(argv);}catch(error){stderr.write('codico: '+String((error as Error).message)+'\n\n'+HELP);return 64;}
    if(opts.help){stdout.write(HELP);return 0;}
    const version=cliVersion();
    if(opts.mode==='version'){stdout.write(version+'\n');return 0;}
    const p=painter(opts.color??detectColor(stdout));
    const pe=painter(opts.color??detectColor(stderr));
    if(opts.mode==='config'){return configCommand(opts,p);}

    // User defaults apply only where nothing more specific (flag or CODICO_MODEL) was given.
    const {config,warning}=loadUserConfig();
    if(warning){stderr.write(pe.yellow('codico: '+warning)+'\n');}
    if(!opts.modelExplicit&&config.model){opts.model=config.model;}
    if(!opts.ollamaUrlExplicit&&config.ollamaUrl){opts.ollamaUrl=config.ollamaUrl;}
    if(!opts.maxStepsExplicit&&config.maxSteps){opts.maxSteps=config.maxSteps;}
    if(!opts.verbose&&config.verbose){opts.verbose=true;}

    if(opts.mode==='doctor'){
        stdout.write(p.bold('Codico doctor')+p.gray(' v'+version)+'\n\n');
        const checks=await runDoctor(opts.model,opts.ollamaUrl,opts.cwd);
        stdout.write(formatDoctor(checks,p));
        return checks.some(c=>c.status==='fail')?1:0;
    }

    const interactive=opts.mode==='chat';
    const rich=!opts.json&&(interactive||!!stdout.isTTY);
    const output=new MutableOutput(stdout);
    const toolNames=new Set(getNativeToolDefinitions().map(t=>t.name));
    const files={current:undefined as FileIndex|undefined};
    let project:ProjectContext|undefined;
    const terminal=readline.createInterface({
        input:stdin,output:output as unknown as NodeJS.WritableStream,terminal:!!stdin.isTTY&&interactive,
        history:interactive?loadHistory():[],historySize:500,removeHistoryDuplicates:true,
        completer:interactive?((line:string)=>completer({
            commands:[...CHAT_COMMANDS,...(project?.extensions.skills.map(s=>'/'+s.name)??[])],
            agents:()=>project?.extensions.agents.map(a=>a.name)??[],
            files:files.current!,
        })(line)):undefined,
    });
    const renderer=new TranscriptRenderer(stdout,stderr,pe,toolNames,opts.verbose);
    const sessionAllow=new Set<'write'|'command'>();
    let running:AbortController|undefined;
    let shell:ChildProcess|undefined;
    let idlePrompt:AbortController|undefined;
    let lastInterrupt=0;
    const clearLine=():void=>{terminal.write('',{ctrl:true,name:'e'});terminal.write('',{ctrl:true,name:'u'});};

    const approve=async(kind:'write'|'command',description:string):Promise<boolean>=>{
        if(opts.yes||opts.auto||sessionAllow.has(kind)){return true;}
        if(!stdin.isTTY){return false;}
        const spinning=renderer.spinner.active;
        renderer.spinner.stop();
        const [head,...rest]=sanitize(description.slice(0,8000)).split('\n');
        const e=pe;
        const lines=['',`${e.yellow('?')} ${e.bold(kind==='write'?'Allow this change?':'Allow this command?')}`,`  ${e.bold(head)}`];
        if(rest.length){lines.push(colorDiff(rest.join('\n'),e,Math.max(20,(stdout.rows||40)-12)));}
        lines.push(`  ${e.green('enter')} approve   ${e.red('esc')} deny   ${e.accent('a')} approve, and don't ask again for ${kind==='write'?'edits':'commands'} this session`);
        stderr.write(lines.join('\n')+'\n');
        // One keypress decides. Only keys pressed after the card is shown count, so text typed
        // ahead during the turn can never answer an approval by accident.
        const wasMuted=output.muted;
        output.muted=true;
        const signal=running?.signal;
        const answer=await new Promise<'y'|'a'|'n'>(resolve=>{
            const finish=(value:'y'|'a'|'n'):void=>{
                stdin.off('keypress',onKey);
                signal?.removeEventListener('abort',onAbort);
                resolve(value);
            };
            const onKey=(text:string|undefined,key:{name?:string;ctrl?:boolean}|undefined):void=>{
                const ch=(text??'').toLowerCase();
                if(ch==='y'||key?.name==='return'||key?.name==='enter'){finish('y');}
                else if(ch==='a'){finish('a');}
                else if(ch==='n'||key?.name==='escape'){finish('n');}
            };
            const onAbort=():void=>finish('n');
            if(signal?.aborted){resolve('n');return;}
            stdin.on('keypress',onKey);
            signal?.addEventListener('abort',onAbort,{once:true});
        });
        // readline saw the same key; drop it from the input line while output is still muted.
        clearLine();
        output.muted=wasMuted;
        const allowed=answer!=='n';
        if(answer==='a'){sessionAllow.add(kind);}
        stderr.write(allowed?e.green(`  ${SYMBOLS.check} approved${answer==='a'?` · ${kind==='write'?'edits':'commands'} auto-approved for this session`:''}\n`):e.yellow('  denied\n'));
        if(spinning&&running&&!running.signal.aborted){renderer.spinner.start('Running');}
        return allowed;
    };

    // A picker is open: it reads keys itself (Esc / Ctrl+C cancel it).
    let modal=false;
    const pick=async<T>(options:SelectOptions<T>):Promise<T|undefined>=>{
        modal=true;
        const wasMuted=output.muted;
        output.muted=true;
        try{return await select(stdin,stdout,p,options);}
        // readline saw the same keys; clear its line while output is still muted, so nothing is redrawn.
        finally{clearLine();output.muted=wasMuted;modal=false;}
    };

    terminal.on('SIGINT',()=>{
        if(modal){return;}
        if(running){
            renderer.spinner.stop();
            running.abort();
            return;
        }
        if(shell){shell.kill();return;}
        const now=Date.now();
        if(terminal.line){clearLine();lastInterrupt=0;return;}
        if(now-lastInterrupt<1500){idlePrompt?.abort();return;}
        lastInterrupt=now;
        stdout.write('\n'+p.gray('  (press ctrl+c again to exit)')+'\n');
        terminal.prompt(true);
    });

    let browser:CliBrowser|undefined;
    let web:CliWeb|undefined;
    let mcp:StdioMcp|undefined;
    let session:SavedSession|undefined;
    let agent:StandaloneAgent|undefined;
    const plainEvent=(e:StandaloneEvent):void=>{
        if(opts.json){if(e.type!=='delta'){stdout.write(JSON.stringify(e)+'\n');}return;}
        if(e.type==='text'){stdout.write('\n'+(e.text??'')+'\n');}
        else if(e.type==='toolStart'){stderr.write('  > '+e.tool+' '+(e.text??'')+'\n');}
        else if(e.type==='toolResult'&&!e.ok){stderr.write('  ! '+e.tool+': '+(e.text??'').slice(0,300)+'\n');}
    };
    // The agent's own step-limit note is replaced by the friendly failure line.
    const event=rich?(e:StandaloneEvent)=>{if(e.type==='text'&&/^Stopped after \d+ model requests/.test(e.text??'')){return;}renderer.handle(e);}:plainEvent;
    try{
        const store=opts.noSession?undefined:new SessionStore(opts.cwd);
        let resumed=false;
        if(opts.resume){
            if(!store){throw new Error('Session storage is disabled');}
            session=opts.resume==='last'?store.latest():store.load(opts.resume);
            if(!session){throw new Error('No previous session for this workspace');}
            if(!opts.modelExplicit){opts.model=session.model;}
            resumed=true;
        }else if(store){session=store.create(opts.model);}
        project=new ProjectContext(opts.cwd);
        if(opts.allowMcp){
            mcp=new StdioMcp(opts.cwd,approve);
            const issues=await mcp.connect(loadMcpConfig(opts.cwd,opts.mcpConfig));
            for(const issue of issues){stderr.write(pe.yellow('codico: '+issue)+'\n');}
        }
        if(opts.allowBrowser){browser=new CliBrowser(approve,opts.browserPath??process.env.CODICO_CHROME_PATH,opts.browserLocal);}
        if(opts.allowWeb){web=new CliWeb(approve);}
        const makeAgent=(history:ChatMessage[]):StandaloneAgent=>{
            const instance=new StandaloneAgent({
                cwd:opts.cwd,model:opts.model,permissions:opts.permissions,approve,
                maxSteps:opts.maxSteps,ollamaUrl:opts.ollamaUrl,project,mcp,browser,web,onEvent:event,
            });
            instance.history.push(...history);
            files.current=new FileIndex(instance.workspace);
            return instance;
        };
        const persist=():void=>{
            if(!session||!store||!agent){return;}
            session.history=agent.history;
            session.model=opts.model;
            store.save(session);
        };
        agent=makeAgent(session?.history??[]);
        let shellContext='';

        const applyMode=(next:ChatMode):void=>{
            if(next==='auto'&&!opts.auto&&interactive){
                stderr.write(pe.yellow(`  ! Auto mode: Codico will edit files and run commands without asking. Commands run with your account's full rights.`)+'\n');
            }
            opts.auto=next==='auto';
            opts.plan=next==='plan';
            opts.permissions=MODE_PERMISSION[next];
            if(opts.permissions==='read'){sessionAllow.clear();}
            if(next==='edits'){sessionAllow.delete('command');}
            agent=makeAgent(agent!.history);
            if(next!=='plan'){planReady=false;}
            if(interactive){rememberWorkspaceMode(opts.cwd,next);}
        };
        /** Model problems the user can fix by choosing another model. */
        let lastFailure:{modelIssue:boolean;stepLimit:boolean;prompt:string}|undefined;
        /** Plan mode: a plan was shown and not approved, so the next message revises it. */
        let planReady=false;

        const run=async(prompt:string):Promise<boolean>=>{
            lastFailure=undefined;
            const controller=new AbortController();
            running=controller;
            const stop=()=>controller.abort();
            process.on('SIGINT',stop);
            if(interactive){output.muted=true;}
            if(rich){renderer.beginTurn();}
            let outcome:'done'|'stopped'|'failed'='done';
            let message:string|undefined;
            let hint:string|undefined;
            try{
                let task=prompt;
                if(interactive){
                    const attached=await attachMentions(prompt,agent!.workspace,controller.signal);
                    if(attached.attached.length){renderer.spinner.stop();stderr.write(pe.gray(`  ${SYMBOLS.branch}  attached ${attached.attached.join(', ')}`)+'\n');renderer.spinner.start('Thinking');}
                    if(attached.failed.length){renderer.spinner.stop();stderr.write(pe.yellow(`  could not attach ${attached.failed.join(', ')} (missing, ignored or protected)`)+'\n');renderer.spinner.start('Thinking');}
                    task=attached.prompt;
                    if(shellContext){task=shellContext+'\n\n'+task;shellContext='';}
                }
                await agent!.run(task,controller.signal);
                if(controller.signal.aborted){throw new Error('Agent stopped');}
            }catch(error){
                if(controller.signal.aborted){outcome='stopped';}
                else{outcome='failed';message=(error as Error).message;}
                // Close the unanswered request so the next prompt is not read as a continuation of it.
                const history=agent!.history;
                if(history.length&&history[history.length-1].role!=='assistant'){
                    history.push({role:'assistant',content:outcome==='stopped'
                        ?'[Interrupted by the user before this request was finished. Wait for new instructions.]'
                        :'[This request failed before it was finished: '+(message??'').slice(0,300)+']'});
                }
                if(outcome==='failed'&&rich){
                    const friendly=friendlyError(message??'',opts.model,opts.ollamaUrl);
                    lastFailure={modelIssue:!!friendly.modelIssue,stepLimit:!!friendly.stepLimit,prompt};
                    message=friendly.title;hint=interactive&&friendly.stepLimit?undefined:friendly.hint;
                }
                if(!interactive){
                    // One-shot runs end here; rich output has already explained the failure.
                    if(rich){renderer.endTurn(outcome,message,hint);}
                    throw Object.assign(error instanceof Error?error:new Error(String(error)),{reported:rich});
                }
            }finally{
                process.removeListener('SIGINT',stop);
                running=undefined;
                output.muted=false;
                persist();
                if(rich&&!(outcome!=='done'&&!interactive)){renderer.endTurn(outcome,message,hint);}
            }
            return outcome==='done';
        };

        if(opts.mode==='agent'){
            await run(opts.plan?PLAN_PROMPT+opts.prompt:opts.prompt);
            if(opts.json&&session){stdout.write(JSON.stringify({type:'session',id:session.id})+'\n');}
            return 0;
        }
        if(!stdin.isTTY){stderr.write('codico: chat requires a TTY; use codico agent "<task>" for scripts\n');return 64;}

        const ask=async(promptText:string):Promise<string|undefined>=>{
            idlePrompt=new AbortController();
            try{return await terminal.question(promptText,{signal:idlePrompt.signal});}
            catch{return undefined;}
            finally{idlePrompt=undefined;}
        };
        const promptLabel=():string=>(opts.auto?p.yellow(MODE_TAG.auto+' '):opts.plan?p.cyan(MODE_TAG.plan+' '):p.gray(MODE_TAG[modeOf(opts)]+' '))+p.accent(SYMBOLS.prompt)+' ';

        /** Let the user pick a model that works on this machine; returns true when the model changed. */
        const chooseModel=async(title:string,save:boolean):Promise<boolean>=>{
            renderer.spinner.start('Looking for models');
            const choices=await modelChoices(opts.model,opts.ollamaUrl);
            renderer.spinner.stop();
            if(choices.length===1){
                stdout.write([
                    p.yellow('  No models are available on this computer yet. To get one:'),
                    `    ${p.accent('•')} Install Ollama (https://ollama.com), then run: ${p.bold('ollama pull qwen2.5-coder:7b')}`,
                    `    ${p.accent('•')} or set an API key, e.g. ${p.bold('ANTHROPIC_API_KEY')}, ${p.bold('OPENAI_API_KEY')}, ${p.bold('DEEPSEEK_API_KEY')} or ${p.bold('OPENROUTER_API_KEY')}`,
                    p.gray('    Then start codico again. "codico doctor" checks your setup.'),'',
                ].join('\n')+'\n');
            }
            let chosen=await pick({title,choices,maxVisible:12});
            if(chosen===CUSTOM_MODEL){
                const typed=(await ask(p.gray('  Model ID (e.g. ollama/llama3.2, direct:openai/gpt-5, anthropic/claude-sonnet-4.5): ')))?.trim();
                chosen=typed||undefined;
            }
            if(!chosen||chosen===opts.model){return false;}
            const problem=await modelProblem(chosen,opts.ollamaUrl);
            if(problem){stdout.write(p.yellow(`  ! ${problem}`)+p.gray(' Using it anyway.')+'\n');}
            persist();
            opts.model=chosen;
            agent=makeAgent(agent!.history);
            if(session){session.model=chosen;persist();}
            if(save){
                try{setUserConfig('model',chosen);stdout.write(p.gray(`  Saved as your default model. Change it any time with /model.`)+'\n');}
                catch{/* the session still uses it */}
            }
            return true;
        };
        const chooseMode=async(title:string,initial:ChatMode=modeOf(opts)):Promise<ChatMode|undefined>=>pick<ChatMode>({
            title,
            choices:MODE_ORDER.map(m=>({value:m,label:MODE_LABEL[m],current:m===initial,
                hint:m==='agent'?'recommended':m==='auto'?'no approvals':undefined})),
            initial:MODE_ORDER.indexOf(initial),
            footer:'↑↓ to move · enter to choose · shift+tab switches later',
        });

        // Before every session: make sure the model works and ask what Codico may do
        // (the folder's last choice is pre-selected; --auto / --allow-* skip the question).
        const problem=opts.modelExplicit?undefined:await modelProblem(opts.model,opts.ollamaUrl);
        const remembered=opts.permissionsExplicit?undefined:normalizeMode(workspaceMode(opts.cwd));
        const askMode=!opts.permissionsExplicit;
        if(problem||askMode){stdout.write(`\n${p.accent('✻')} ${p.bold(remembered?'Codico':'Welcome to Codico')} ${p.gray('v'+version)}\n\n`);}
        if(problem){
            stdout.write(p.yellow(`  ${problem}`)+'\n');
            await chooseModel('Which model should Codico use?',true);
            stdout.write('\n');
        }
        if(askMode){
            const mode=await chooseMode(`How should Codico work in ${path.basename(opts.cwd)||opts.cwd} this session?`,remembered??'agent');
            applyMode(mode??remembered??'ask');
            stdout.write(p.gray('  Press shift+tab or type /mode to change it at any time.')+'\n\n');
        }else if(opts.auto){
            stdout.write(pe.yellow(`  ! Auto mode: Codico will edit files and run commands without asking. Commands run with your account's full rights.`)+'\n');
        }
        // A recent conversation in this folder: offer to pick it up instead of starting from nothing.
        if(!resumed&&store){
            const last=store.latest();
            // What the user typed: not tool results (old or new format), summaries or Codico's own prompts.
            const requests=last?last.history.filter(m=>isUserRequest(m)&&
                !/^(\[|You are a task planner|The user approved the plan|Continue the task from where)/.test(userRequestText(m,200).trimStart())):[];
            const age=last?Date.now()-Date.parse(last.updatedAt):Infinity;
            if(last&&requests.length&&age<3*24*3600_000){
                const ago=age<3600_000?`${Math.max(1,Math.round(age/60_000))} min ago`:age<86400_000?`${Math.round(age/3600_000)} h ago`:`${Math.round(age/86400_000)} d ago`;
                const lastAsked=userRequestText(requests[requests.length-1],70).replace(/\s+/g,' ').trim();
                const choice=await pick<'continue'|'new'>({
                    title:`Continue your last conversation here? (${ago}: "${lastAsked}")`,
                    choices:[{value:'continue',label:'Continue it'},{value:'new',label:'Start a new conversation'}],
                    footer:'enter to continue · esc for a new one · codico -c skips this',
                });
                if(choice==='continue'){
                    session=last;
                    agent=makeAgent(last.history);
                    if(session.model!==opts.model){session.model=opts.model;}
                    resumed=true;
                }
                stdout.write('\n');
            }
        }
        stdout.write(banner(p,version,opts.model,modeOf(opts),opts.cwd,session?.id,resumed));
        if(resumed&&session){stdout.write(p.gray(`  ${session.history.filter(m=>m.role==='user').length} earlier messages restored`)+'\n\n');}

        // Shift+Tab cycles what Codico may do, while the prompt is waiting.
        stdin.on('keypress',(_text:string|undefined,key:{name?:string;shift?:boolean}|undefined)=>{
            if(!idlePrompt||running||modal||key?.name!=='tab'||!key.shift){return;}
            applyMode(MODE_ORDER[(MODE_ORDER.indexOf(modeOf(opts))+1)%MODE_ORDER.length]);
            terminal.setPrompt(promptLabel());
            terminal.prompt(true);
        });

        /** After a failed turn: offer another model when the model is the problem, more steps when they ran out. */
        const recover=async(ok:boolean):Promise<boolean>=>{
            if(!ok&&lastFailure?.modelIssue){
                const retry=lastFailure.prompt;
                if(await chooseModel('Choose a model to retry with',true)){
                    stdout.write(p.gray(`  Retrying with ${opts.model}…`)+'\n');
                    ok=await run(retry);
                }
            }
            // Out of steps mid-task: one keypress keeps it going, as often as needed.
            while(!ok&&lastFailure?.stepLimit){
                const next=await pick({title:'Codico ran out of steps. Keep going?',
                    choices:[{value:'go',label:`Keep going (${opts.maxSteps} more steps)`},{value:'stop',label:'Stop here'}],
                    footer:'enter to keep going · esc to stop'});
                if(next!=='go'){break;}
                ok=await run('Continue the task from where you stopped. Do not redo finished work.');
            }
            return ok;
        };

        /**
         * Plan a request read-only (enforced even when the session may edit), then let the user approve it:
         * Agent or Auto carries it out; otherwise the next message revises the plan.
         */
        const planFlow=async(request:string):Promise<void>=>{
            const before=modeOf(opts);
            const readOnlyNow=opts.permissions!=='read';
            if(readOnlyNow){opts.permissions='read';agent=makeAgent(agent!.history);}
            let ok:boolean;
            try{ok=await recover(await run((planReady?REVISE_PLAN_PREFIX:PLAN_PROMPT)+request));}
            finally{if(readOnlyNow){opts.permissions=MODE_PERMISSION[before];agent=makeAgent(agent!.history);}}
            if(!ok){return;}
            const choice=await pick<'agent'|'auto'|'revise'>({
                title:'Carry out this plan?',
                choices:[
                    {value:'agent',label:'Yes, with Agent',hint:'asks before each change'},
                    {value:'auto',label:'Yes, with Auto',hint:'no approvals'},
                    {value:'revise',label:'No, keep planning',hint:'then type what to change'},
                ],
                initial:before==='auto'?1:0,
                footer:'enter to choose · esc to keep planning',
            });
            if(choice==='agent'||choice==='auto'){
                applyMode(choice);
                await recover(await run(EXECUTE_PLAN_PROMPT));
                return;
            }
            if(!opts.plan){applyMode('plan');}
            planReady=true;
            stdout.write(p.gray('  Type what to change in the plan, or press shift+tab to switch mode.')+'\n');
        };

        const runShell=(command:string):Promise<void>=>new Promise(resolve=>{
            let captured='';
            const child=spawn(command,{cwd:opts.cwd,shell:true,stdio:['ignore','pipe','pipe'],windowsHide:true});
            shell=child;
            const take=(chunk:Buffer,target:NodeJS.WriteStream)=>{
                const text=chunk.toString('utf8');
                target.write(text);
                if(captured.length<12000){captured+=text;}
            };
            child.stdout?.on('data',c=>take(c,stdout));
            child.stderr?.on('data',c=>take(c,stderr));
            const finish=(code:number|null,error?:Error)=>{
                shell=undefined;
                const status=error?`failed: ${error.message}`:`exit code ${code??'killed'}`;
                stdout.write((code===0?p.gray:p.yellow)(`  ${SYMBOLS.branch}  ${status} · output will be shared with your next message`)+'\n');
                shellContext=`[The user ran a shell command in the workspace: ${command}]\n[${status}]\n${sanitize(captured).slice(-12000)}`;
                resolve();
            };
            child.on('error',e=>finish(null,e));
            child.on('close',code=>finish(code));
        });

        const status=():void=>{
            const rows:[string,string][]=[
                ['version',version],['model',opts.model],['mode',MODE_LABEL[modeOf(opts)]+(sessionAllow.size?` · auto-approving ${[...sessionAllow].join(', ')}`:'')],
                ['cwd',tildify(opts.cwd)],['session',session?.id??'(not saved)'],
                ['messages',String(agent!.history.length)],['max steps',String(opts.maxSteps)],
                ['tokens',`${formatTokens(renderer.totals.promptTokens)} in · ${formatTokens(renderer.totals.completionTokens)} out`],
                ['web',opts.allowWeb?'on':'off'],['browser',opts.allowBrowser?'on':'off'],
                ['mcp',mcp?`${mcp.tools.length} tools`:'off'],['verbose',opts.verbose?'on':'off'],
                ['config',configFile()],
            ];
            stdout.write(rows.map(([k,v])=>`  ${p.gray(k.padEnd(10))}${v}`).join('\n')+'\n');
        };

        for(;;){
            let prompt=await ask(promptLabel());
            if(prompt===undefined){break;}
            while(prompt.endsWith('\\')){
                const more=await ask(p.gray('… '));
                if(more===undefined){break;}
                prompt=prompt.slice(0,-1)+'\n'+more;
            }
            prompt=prompt.trim();
            if(!prompt){continue;}
            if(prompt==='/'){
                const picked=await pick({title:'Command',maxVisible:12,
                    choices:COMMAND_INFO.map(c=>({value:c,label:c.name,hint:c.description}))});
                if(!picked){continue;}
                prompt=picked.name;
                if(picked.arg){
                    const value=(await ask(p.gray(`  ${picked.arg} `)))?.trim();
                    if(!value){continue;}
                    prompt+=' '+value;
                }
            }
            appendHistory(prompt);
            const [command,...restWords]=prompt.split(/\s+/);
            const rest=prompt.slice(command.length).trim();
            if(prompt.startsWith('!')){
                const cmd=prompt.slice(1).trim();
                if(cmd){await runShell(cmd);}
                continue;
            }
            if(command==='/exit'||command==='/quit'||/^(exit|quit|bye|:q)$/i.test(prompt)){break;}
            if(command==='/help'){stdout.write(chatHelp(p));continue;}
            if(command==='/status'){status();continue;}
            if(command==='/verbose'){opts.verbose=!opts.verbose;renderer.verbose=opts.verbose;stdout.write(`  Verbose tool output ${opts.verbose?'on':'off'}\n`);continue;}
            if(command==='/cost'){
                stdout.write(`  ${formatTokens(renderer.totals.promptTokens)} input · ${formatTokens(renderer.totals.completionTokens)} output tokens over ${renderer.totals.turns} turn${renderer.totals.turns===1?'':'s'}\n`);
                continue;
            }
            if(command==='/diff'){
                const git=(args:string[])=>spawnSync('git',args,{cwd:opts.cwd,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
                const inside=git(['rev-parse','--is-inside-work-tree']);
                if(inside.status!==0){stderr.write(pe.yellow('  '+(inside.error?'git is not installed':'Not a git repository; /diff needs git'))+'\n');continue;}
                const diff=git(['--no-pager','diff',...(p.enabled?['--color=always']:[]),...restWords]);
                const stat=git(['--no-pager','diff','--stat',...restWords]);
                const untracked=git(['ls-files','--others','--exclude-standard',...restWords]).stdout.split('\n').filter(Boolean);
                if(diff.status!==0){stderr.write(pe.red('  git diff failed: '+(diff.stderr.split('\n')[0]||'').trim())+'\n');continue;}
                if(!diff.stdout.trim()&&!untracked.length){stdout.write(p.gray('  No uncommitted changes.')+'\n');continue;}
                if(diff.stdout.trim()){stdout.write(diff.stdout+'\n'+stat.stdout);}
                if(untracked.length){stdout.write(p.gray(`  ${untracked.length} untracked file${untracked.length===1?'':'s'}: `)+untracked.slice(0,20).join(', ')+(untracked.length>20?' …':'')+'\n');}
                continue;
            }
            if(command==='/sessions'){
                if(!store){stdout.write('  Session storage disabled\n');continue;}
                const list=store.list().slice(0,25);
                if(!list.length){stdout.write(p.gray('  No saved sessions.')+'\n');}
                for(const s of list){stdout.write(`  ${s.id===session?.id?p.accent(SYMBOLS.dot):' '} ${p.bold(s.id.slice(0,8))}  ${p.gray(new Date(s.updatedAt).toLocaleString())}  ${s.model}\n`);}
                continue;
            }
            if(command==='/skills'){
                stdout.write('  Project agents: '+(project.extensions.agents.map(x=>'@'+x.name).join(', ')||p.gray('(none)'))+'\n');
                stdout.write('  Project skills: '+(project.extensions.skills.map(x=>'/'+x.name).join(', ')||p.gray('(none)'))+'\n');
                continue;
            }
            if(command==='/mcp'){
                stdout.write('  MCP tools: '+(mcp?.tools.map(x=>x.server+'/'+x.name).join(', ')||p.gray('(none; start with --allow-mcp)'))+'\n');
                continue;
            }
            if(command==='/new'||command==='/clear'){
                persist();
                session=store?.create(opts.model);
                agent=makeAgent([]);
                stdout.write(p.gray('  Started a new conversation'+(session?' '+session.id.slice(0,8):''))+'\n');
                continue;
            }
            if(command==='/resume'){
                if(!store){stdout.write('  Sessions disabled\n');continue;}
                const id=rest||'last';
                try{
                    persist();
                    const found=id==='last'?undefined:store.list().find(s=>s.id.startsWith(id));
                    const match=id==='last'?store.latest():found?store.load(found.id):undefined;
                    if(!match){throw new Error('No matching session');}
                    session=match;opts.model=match.model;agent=makeAgent(match.history);
                    stdout.write(p.gray(`  Resumed ${match.id.slice(0,8)} (${opts.model}, ${match.history.filter(m=>m.role==='user').length} messages)`)+'\n');
                }catch(error){stderr.write(pe.red('  '+String((error as Error).message))+'\n');}
                continue;
            }
            if(command==='/model'){
                if(!rest){await chooseModel('Which model should Codico use?',true);continue;}
                const problem=await modelProblem(rest,opts.ollamaUrl);
                if(problem){stdout.write(p.yellow(`  ! ${problem}`)+p.gray(' Using it anyway.')+'\n');}
                persist();opts.model=rest;
                agent=makeAgent(agent!.history);
                if(session){session.model=rest;persist();}
                stdout.write(`  Model: ${p.bold(rest)}\n`);continue;
            }
            if(command==='/mode'){
                const aliases:Record<string,ChatMode>={ask:'ask',read:'ask','read-only':'ask',plan:'plan',agent:'agent',all:'agent',run:'agent',edit:'edits',edits:'edits',auto:'auto',yolo:'auto'};
                const next=rest?aliases[rest.toLowerCase()]:await chooseMode('How should Codico work?');
                if(rest&&!next){stderr.write(pe.yellow('  Use /mode ask, plan, agent or auto, or just /mode to choose from a list')+'\n');continue;}
                if(!next){continue;}
                applyMode(next);
                if(rest){stdout.write(`  ${p.green(SYMBOLS.check)} ${MODE_LABEL[next]}\n`);}
                continue;
            }
            if(command==='/compact'){
                // Same engine as automatic compaction: the summary request is sized to fit the model.
                const controller=new AbortController();
                running=controller;
                renderer.spinner.start('Compacting the conversation');
                try{
                    const done=await agent!.compact(controller.signal);
                    renderer.spinner.stop();
                    if(!done){stdout.write(p.gray('  Nothing to compact yet.')+'\n');}
                    persist();
                }catch(error){
                    renderer.spinner.stop();
                    stderr.write((controller.signal.aborted?pe.yellow('  Compaction interrupted'):pe.red('  Compaction failed: '+friendlyError((error as Error).message,opts.model,opts.ollamaUrl).title))+'\n');
                }finally{running=undefined;}
                continue;
            }
            if(command==='/init'){
                if(opts.permissions==='read'){stderr.write(pe.yellow('  /init writes AGENTS.md; switch to Agent first (shift+tab or /mode agent)')+'\n');continue;}
                await run(INIT_PROMPT+(rest?'\n\nAlso: '+rest:''));
                continue;
            }
            if(command==='/plan'||command==='/review'){
                if(!rest){stderr.write(pe.yellow(`  Usage: ${command} <task>`)+'\n');continue;}
                if(command==='/plan'){planReady=false;await planFlow(rest);}
                else{await recover(await run(REVIEW_PROMPT+'\n\n'+rest));}
                continue;
            }
            if(command.startsWith('/')&&!project.extensions.skills.some(s=>command==='/'+s.name)){
                stderr.write(pe.yellow(`  Unknown command ${command}. Type /help for the list.`)+'\n');
                continue;
            }
            if(opts.plan){await planFlow(prompt);continue;}
            await recover(await run(prompt));
        }
        stdout.write(p.gray(session?`\n  Session saved · resume with: codico --continue\n`:'\n'));
        return 0;
    }catch(error){
        renderer.spinner.stop();
        const message=error instanceof Error?error.message:String(error);
        if(opts.json){stdout.write(JSON.stringify({type:'error',message})+'\n');}
        else if(!(error as {reported?:boolean}).reported){stderr.write('codico: '+message+'\n');}
        return 1;
    }finally{
        renderer.spinner.stop();
        await mcp?.close();
        await browser?.close();
        terminal.close();
    }
}
