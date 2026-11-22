/** Explicitly permissioned, SSRF-resistant public web tools for the terminal host. */
import * as http from 'node:http';
import * as https from 'node:https';
import { resolvePublicHttpUrl } from '../networkSecurity';
import { searchRequest, parseDuckDuckGo, parseBrave, renderResults, duckDuckGoRefused } from '../webSearch';
import { wrapUntrusted } from '../untrustedContent';
import type { CliApproval } from './nodeWorkspace';
import type { ToolCall } from '../toolParser';

const MAX_BODY = 1024 * 1024;

function download(address: string, headers: Record<string,string>, signal: AbortSignal, redirects = 3): Promise<string> {
    return resolvePublicHttpUrl(address).then(({url,lookup})=>new Promise<string>((resolve,reject)=>{
        if (signal.aborted) {reject(new Error('Stopped'));return;}
        const protocol=url.protocol==='https:'?https:http;
        const req=protocol.request(url,{
            method:'GET',headers:{'User-Agent':'CodicoCLI/1.0',Accept:'text/html,application/json,text/plain,*/*',...headers},
            lookup,timeout:15000,signal,
        },res=>{
            const status=res.statusCode??0;
            if(status>=300&&status<400&&res.headers.location){
                res.resume();
                if(redirects<=0){reject(new Error('Too many redirects'));return;}
                const next=new URL(res.headers.location,url).href;
                download(next,headers,signal,redirects-1).then(resolve,reject);
                return;
            }
            if(status<200||status>=300){res.resume();reject(new Error('HTTP '+status));return;}
            const type=String(res.headers['content-type']??'').toLowerCase();
            if(!/text\/|application\/(json|xml|javascript|xhtml)/.test(type)){res.resume();reject(new Error('Unsupported response content-type: '+type));return;}
            const chunks:Buffer[]=[];
            let total=0;
            res.on('data',(chunk:Buffer)=>{
                total+=chunk.length;
                if(total>MAX_BODY){res.destroy(new Error('Response exceeds 1 MB'));return;}
                chunks.push(chunk);
            });
            res.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error',reject);
        });
        req.on('timeout',()=>req.destroy(new Error('Web request timed out')));
        req.on('error',reject);
        req.end();
    }));
}

function readable(html: string): string {
    return html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi,' ')
        .replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ')
        .replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
        .replace(/[ \t]{2,}/g,' ').replace(/\n{3,}/g,'\n\n').trim().slice(0,12000);
}

export class CliWeb {
    constructor(private readonly approve:CliApproval) {}
    async execute(tool:ToolCall, signal:AbortSignal):Promise<string> {
        if(tool.type==='fetch_url'){
            await resolvePublicHttpUrl(tool.url);
            if(!await this.approve('command','Read external webpage '+tool.url)){
                return 'Denied: external web fetch was not approved';
            }
            return wrapUntrusted('web '+tool.url,readable(await download(tool.url,{},signal)));
        }
        if(tool.type==='web_search'){
            if(!await this.approve('command','Search the web for '+tool.query.slice(0,400))){
                return 'Denied: web search was not approved';
            }
            const key=process.env.BRAVE_SEARCH_API_KEY;
            const engine=key?'brave':'duckduckgo';
            const {url,headers}=searchRequest(engine,tool.query,key);
            const body=await download(url,headers,signal);
            if(engine==='duckduckgo'&&duckDuckGoRefused(body)){
                return 'Web search was declined by DuckDuckGo. Set BRAVE_SEARCH_API_KEY to use Brave.';
            }
            const results=engine==='brave'?parseBrave(body):parseDuckDuckGo(body);
            return wrapUntrusted('web search',renderResults(results).slice(0,12000));
        }
        return 'Web tool unavailable';
    }
}
