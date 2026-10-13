import * as cp from 'child_process';
import * as os from 'os';
import * as vscode from 'vscode';
import { hitTheSandbox, sandboxedCommand, sandboxExplanation, SandboxPolicy, sandboxPolicy, SandboxTool, sandboxToolFor } from './commandSandbox';

export type SandboxMode = 'off' | 'auto' | 'required';

/** Whether the sandbox of this system actually works here (the tool is installed and allowed to run). Asked once. */
let probed: Promise<boolean> | undefined;
export function sandboxWorks(tool: SandboxTool | undefined = sandboxToolFor(process.platform)): Promise<boolean> {
    if (!tool) { return Promise.resolve(false); }
    probed ??= new Promise<boolean>(resolve => {
        const policy = sandboxPolicy({ workspaceFolders: [], home: os.homedir(), tmp: os.tmpdir() });
        const { file, args } = sandboxedCommand(tool, policy, '/bin/sh', 'exit 0');
        // From the root: the folder this process happens to be in may not exist inside the sandbox
        cp.execFile(file, args, { timeout: 10_000, cwd: '/' }, error => resolve(!error));
    });
    return probed;
}

export interface CommandSandbox {
    /** Given to the process runner; undefined when the command runs unconfined. */
    wrap?: (shell: string, command: string) => { file: string; args: string[] };
    /** Set when commands must be confined and cannot be: the command is not run. */
    refusal?: string;
    /** Added to a failed command's output when the failure looks like the sandbox's doing. */
    explain(output: string, exitCode: number): string;
}

/** The sandbox for the next command, from the user's settings. Settings are per machine: a project cannot switch it off. */
export async function commandSandbox(): Promise<CommandSandbox> {
    const config = vscode.workspace.getConfiguration('codico');
    const mode = config.get<SandboxMode>('commandSandbox', 'off');
    const none: CommandSandbox = { explain: () => '' };
    if (mode !== 'auto' && mode !== 'required') { return none; }
    const tool = sandboxToolFor(process.platform);
    if (!tool || !await sandboxWorks(tool)) {
        if (mode === 'auto') { return none; }
        const why = !tool ? 'this operating system has no sandbox Codico can use' : tool === 'bubblewrap' ? 'bubblewrap (the "bwrap" command) is not installed or not allowed to run' : 'the system sandbox could not be started';
        return { ...none, refusal: `Not run: commands must be sandboxed (the codico.commandSandbox setting is "required") and ${why}. Tell the user; do not look for another way to run it.` };
    }
    const policy: SandboxPolicy = sandboxPolicy({
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath),
        home: os.homedir(), tmp: os.tmpdir(),
        extraWritable: config.get<string[]>('commandSandboxWritablePaths', []).map(item => item.replace(/^~(?=$|[\\/])/, os.homedir())),
        network: config.get<boolean>('commandSandboxNetwork', true),
    });
    return {
        wrap: (shell, command) => sandboxedCommand(tool, policy, shell, command),
        explain: (output, exitCode) => exitCode !== 0 && hitTheSandbox(output) ? `\n${sandboxExplanation(policy)}` : '',
    };
}
