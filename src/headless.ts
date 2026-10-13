import * as fs from 'fs';
import * as vscode from 'vscode';
import { ExtensionMessage } from './chatProtocol';
import { directSecretKey } from './directProviderClient';

/**
 * Headless runs: Codico working on one task with nobody at the screen (a script, CI, a
 * schedule). The `codico` command starts the editor for it and reads what is written here.
 *
 * With nobody to ask, everything that would be a question is a rule set beforehand:
 * what the task may do is given on the command line, and every other prompt is declined.
 */
export interface HeadlessTask {
    prompt: string;
    /** Where progress and the result are written, one JSON object per line. */
    out: string;
    model?: string;
    /** What may be done without asking: nothing, file edits, or edits and terminal commands. */
    permissions: 'read' | 'edits' | 'all';
    allowWeb?: boolean;
    allowHooks?: boolean;
    maxSteps?: number;
    ollamaUrl?: string;
}

export const HEADLESS_ENV = 'CODICO_HEADLESS';
export const HEADLESS_TASK_ENV = 'CODICO_HEADLESS_TASK';
/** Exit codes of a headless run. */
export const EXIT = { done: 0, failed: 1, needsInput: 2, denied: 3 } as const;

/** Keys are taken from the environment, where CI keeps its secrets: variable name by provider. */
export const KEY_VARIABLES: Record<string, string> = {
    OPENROUTER_API_KEY: 'openrouter', ANTHROPIC_API_KEY: 'anthropic', OPENAI_API_KEY: 'openai', GOOGLE_API_KEY: 'google', GEMINI_API_KEY: 'google',
    GROQ_API_KEY: 'groq', DEEPSEEK_API_KEY: 'deepseek', MISTRAL_API_KEY: 'mistral', XAI_API_KEY: 'xai', CEREBRAS_API_KEY: 'cerebras',
};

export function isHeadless(context: vscode.ExtensionContext): boolean {
    return context.extensionMode === vscode.ExtensionMode.Test && process.env[HEADLESS_ENV] === '1';
}

export function parseHeadlessTask(text: string): HeadlessTask | undefined {
    let value: unknown;
    try { value = JSON.parse(text); } catch { return undefined; }
    const task = value as Partial<HeadlessTask> | null;
    if (!task || typeof task.prompt !== 'string' || !task.prompt.trim() || typeof task.out !== 'string' || !task.out) { return undefined; }
    if (task.permissions !== 'read' && task.permissions !== 'edits' && task.permissions !== 'all') { return undefined; }
    return task as HeadlessTask;
}

/** How a dialog is answered when nobody is there: allowed only where the command line said so, otherwise dismissed. */
export function dialogAnswer(message: string, buttons: readonly string[], task: Pick<HeadlessTask, 'allowWeb' | 'allowHooks'>): string | undefined {
    if (task.allowWeb && /^Codico wants to /.test(message)) { return buttons.find(button => button === 'Allow External Actions This Turn') ?? buttons.find(button => button === 'Allow Once'); }
    if (task.allowHooks && /wants Codico to run a command as a .* hook/.test(message)) { return buttons.find(button => button === 'Allow for This Workspace'); }
    return undefined;
}

/** What a message from the agent means for someone reading the run's output. */
export function headlessEvent(message: ExtensionMessage): Record<string, unknown> | undefined {
    switch (message.type) {
        case 'appendContent': return message.text ? { type: 'text', text: message.text } : undefined;
        case 'toolStart': return { type: 'step', tool: message.tool, label: message.label };
        case 'toolResult': return { type: 'result', tool: message.tool, label: message.label, ok: message.success, ...(message.error ? { error: message.error } : {}) };
        case 'error': return { type: 'error', message: message.message };
        default: return undefined;
    }
}

export interface HeadlessAgent {
    readonly ready: boolean;
    backgroundPermissions: 'ask' | 'edits' | 'all';
    backgroundListener?: (message: ExtensionMessage) => void;
    sendMessage(text: string): Promise<void>;
    denyPrompts(): void;
    lastReplyUsage(): { tokens?: number; requests?: unknown[] } | undefined;
}

/** Runs the task of this headless session and returns its exit code. */
export async function runHeadless(context: vscode.ExtensionContext, agent: HeadlessAgent): Promise<number> {
    const task = parseHeadlessTask(fs.readFileSync(process.env[HEADLESS_TASK_ENV] ?? '', 'utf8'));
    if (!task) { throw new Error('The headless task file is missing or not valid.'); }
    const write = (event: Record<string, unknown>) => { try { fs.appendFileSync(task.out, JSON.stringify(event) + '\n'); } catch { /* the reader has gone */ } };
    let denied = 0; let failed: string | undefined; let question = false;
    const windowApi = vscode.window as unknown as Record<string, unknown>;

    // Nobody can answer a dialog. Each is answered by the rules of the run and reported, so that none can hold the run up
    for (const name of ['showWarningMessage', 'showInformationMessage', 'showErrorMessage']) {
        windowApi[name] = async (message: string, ...rest: unknown[]) => {
            const options = rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) ? rest[0] as { modal?: boolean } : undefined;
            const buttons = rest.slice(options ? 1 : 0).map(item => typeof item === 'string' ? item : (item as { title?: string })?.title ?? '');
            const answer = dialogAnswer(message, buttons, task);
            if (options?.modal && !answer) { denied++; }
            write({ type: 'dialog', message, answer: answer ?? null });
            return answer;
        };
    }
    for (const name of ['showInputBox', 'showQuickPick']) { windowApi[name] = async () => undefined; }

    for (const [variable, provider] of Object.entries(KEY_VARIABLES)) {
        const key = process.env[variable]?.trim();
        if (key) { await context.secrets.store(provider === 'openrouter' ? 'openRouterApiKey' : directSecretKey(provider), key); }
    }
    const config = vscode.workspace.getConfiguration('codico');
    const set = (key: string, value: unknown) => config.update(key, value, vscode.ConfigurationTarget.Global);
    if (task.model) { await set('model', task.model); }
    if (task.ollamaUrl) { await set('ollamaBaseUrl', task.ollamaUrl); }
    if (task.maxSteps) { await set('maxIterations', Math.max(1, Math.floor(task.maxSteps))); }
    // Nothing that is only for a person at the screen
    for (const off of ['followUpSuggestionsEnabled', 'completionNotificationsEnabled', 'responseSummaryEnabled', 'autoIndex']) { await set(off, false); }
    await set('notifications', 'never');

    await vscode.commands.executeCommand('workbench.view.extension.codico-container');
    for (let tries = 0; tries < 200 && !agent.ready; tries++) { await new Promise(resolve => setTimeout(resolve, 150)); }
    if (!agent.ready) { write({ type: 'end', status: 'failed', message: 'The Codico panel did not open.' }); return EXIT.failed; }

    agent.backgroundPermissions = task.permissions === 'read' ? 'ask' : task.permissions;
    agent.backgroundListener = message => {
        const event = headlessEvent(message);
        if (event) { write(event); }
        if (message.type === 'error') { failed = message.message; }
        if (message.type === 'appendContent' && message.text.includes('<clarify>')) { question = true; }
        // A request for approval that the rules of this run did not grant: declined, and said
        if (message.type === 'writePermissionRequest' || message.type === 'terminalPermissionRequest' || message.type === 'checkpoint') {
            denied++;
            write({ type: 'denied', what: message.type === 'writePermissionRequest' ? `edit ${message.filepath}` : message.type === 'terminalPermissionRequest' ? `command ${message.command}` : 'continue past the token budget',
                hint: message.type === 'writePermissionRequest' ? 'run with --allow-edits' : message.type === 'terminalPermissionRequest' ? 'run with --allow-commands' : 'raise codico.taskTokenBudget' });
            setTimeout(() => agent.denyPrompts(), 0);
        }
    };
    try {
        await agent.sendMessage(task.prompt);
    } catch (error) {
        failed = error instanceof Error ? error.message : String(error);
    } finally {
        agent.backgroundListener = undefined;
    }
    const usage = agent.lastReplyUsage();
    const status = failed ? 'failed' : question ? 'needs-input' : denied > 0 ? 'denied' : 'done';
    write({ type: 'end', status, ...(failed ? { message: failed } : {}), denied, tokens: usage?.tokens ?? 0, requests: usage?.requests?.length ?? 0 });
    return failed ? EXIT.failed : question ? EXIT.needsInput : denied > 0 ? EXIT.denied : EXIT.done;
}
