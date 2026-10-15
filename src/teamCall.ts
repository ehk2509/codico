import * as vscode from 'vscode';
import { Approvals } from './approvals';
import { githubForRepository } from './automationService';
import { BackgroundTask } from './backgroundTasks';
import { ExtensionMessage } from './chatProtocol';
import { commandSandbox } from './commandSandboxService';
import { PassportRecorder } from './patchPassport';
import { TeamCall } from './teamService';
import { runTerminalProcess } from './terminalProcess';
import { WorkspaceTools } from './workspaceTools';

/** What the orchestrator's turn gives its team calls. */
export interface TeamCallDeps {
    team: string;
    repoRoot: string | undefined;
    msgId: string;
    signal: AbortSignal;
    approvals: Approvals;
    tools: WorkspaceTools;
    passport(): PassportRecorder;
    delegate(task: string): Promise<string>;
    context: vscode.ExtensionContext;
    evaluationMode: boolean;
    post(message: ExtensionMessage): void;
}

/** The team call of one turn: merging, reviewing, and across repositories the integrated tests and publishing. */
export function teamCall(deps: TeamCallDeps): TeamCall {
    const card = (command: string, note?: string) => deps.approvals.askCommand(permId => ({ type: 'terminalPermissionRequest', id: deps.msgId, permId, command, rules: [], ...(note ? { note } : {}) }));
    return {
        team: deps.team, repoRoot: deps.repoRoot, signal: deps.signal,
        // A merge changes a repository like a command does: it is asked for like one
        approveMerge: (task: BackgroundTask) => deps.approvals.allowAllCommands ? Promise.resolve(true) : card(`git -C ${task.repoRoot} merge --no-ff ${task.branch}`),
        review: deps.delegate,
        crossRepo: {
            signal: deps.signal,
            // The integrated tests: asked for, and run, like run_terminal; the result is evidence in the change report
            async runCommand(command, cwd) {
                if (!await deps.tools.askToRun(command, deps.msgId)) { return { exitCode: null, output: '', declined: true }; }
                const sandbox = await commandSandbox();
                if (sandbox.refusal) { return { exitCode: null, output: sandbox.refusal }; }
                deps.post({ type: 'terminalChunk', id: deps.msgId, text: '' });
                const timeout = Math.max(10, vscode.workspace.getConfiguration('codico').get<number>('terminalTimeoutSeconds', 300));
                const result = await runTerminalProcess({ command, cwd, timeoutMs: timeout * 1000, signal: deps.signal, sandbox: sandbox.wrap, onChunk: text => deps.post({ type: 'terminalChunk', id: deps.msgId, text }) });
                deps.passport().recordCommand(command, result.timedOut || result.stopped ? null : result.exitCode ?? null, result.output);
                return { exitCode: result.timedOut || result.stopped ? null : result.exitCode ?? null, output: result.output + (result.error ? `\n${result.error}` : '') };
            },
            github: root => githubForRepository(deps.context, root, { evaluationMode: deps.evaluationMode }),
            // Publishing is public: asked every time, whatever was allowed for the task
            approvePublish: plan => deps.evaluationMode ? Promise.resolve(true) : card(plan, 'Publishes to GitHub: branches are pushed and draft pull requests opened. Asked every time.'),
        },
    };
}
