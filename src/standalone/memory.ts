/** Dedicated, approval-protected project memory tool. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { changeMemory } from '../projectMemory';
import type { CliApproval } from './nodeWorkspace';

export async function rememberInWorkspace(
    workspace:string,
    request:{note?:string;topic?:string;replaces?:string},
    approve:CliApproval
):Promise<string> {
    const folder=path.join(workspace,'.codico');
    const target=path.join(folder,'memory.md');
    try {
        if (fs.existsSync(folder) && !fs.lstatSync(folder).isDirectory()) { return 'Denied: .codico must be a directory'; }
        if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) { return 'Denied: memory path must be a regular file'; }
        const original=fs.existsSync(target) ? fs.readFileSync(target,'utf8') : '';
        if (original.length>100_000) { return 'Denied: project memory too large'; }
        const next=changeMemory(original,request);
        if (!next.ok) { return next.error; }
        if (!await approve('write','Update .codico/memory.md: '+next.said+'\n'+next.content.slice(0,400))) {
            return 'Denied: memory update not approved';
        }
        if (fs.existsSync(target) && fs.readFileSync(target,'utf8')!==original) { return 'Edit rejected: memory changed while awaiting approval'; }
        fs.mkdirSync(folder,{recursive:true,mode:0o700});
        const tmp=path.join(folder,'.codico-memory-'+randomUUID());
        try {
            fs.writeFileSync(tmp,next.content,{encoding:'utf8',flag:'wx',mode:0o600});
            fs.renameSync(tmp,target);
        } finally {
            try {fs.rmSync(tmp,{force:true});} catch {/* no temp */}
        }
        return next.said;
    } catch(error) { return 'Memory error: '+String(error); }
}
