import { criterionLine, parseReview, reviewPrompt } from './acceptance';
import { AppRunner } from './appRunner';
import { commandSandbox } from './commandSandboxService';
import { ExtensionMessage, WebviewMessage } from './chatProtocol';
import * as path from 'path';
import * as vscode from 'vscode';
import { EVIDENCE_DIR, EvidenceStore } from './evidenceStore';
import { ExternalToolRuntime } from './externalToolRuntime';
import { PassportRecorder } from './patchPassport';
import { SubagentHost } from './subagent';
import { toolFolders } from './toolRoot';
import { VerifyTool, BrowserExpectTool } from './verifyTools';
import { requestCheckGuidance } from './requestCheck';
import { WorkspaceTools } from './workspaceTools';

/** What verification needs from the conversation. */
export interface VerifyHost {
    post(message: ExtensionMessage): void;
    /** The change report of the turn in progress, which holds the acceptance record. */
    passport(): PassportRecorder;
    readonly tools: WorkspaceTools;
    readonly external: ExternalToolRuntime;
}

export const DEFAULT_APP_WAIT_SECONDS = 90;
export const MAX_APP_WAIT_SECONDS = 300;
/** Reminders to check the criteria before a reply may end, per turn. */
export const MAX_ACCEPTANCE_REMINDERS = 2;
const REVIEW_SYSTEM = 'You are an independent acceptance reviewer. You did not write the change. Judge only from the evidence given. Be strict: a criterion is shown only when the evidence exercises exactly what it says.';

const describe = (tool: BrowserExpectTool) => tool.selector
    ? `${tool.selector}${tool.text !== undefined ? ` shows "${tool.text}"` : ` is ${tool.state ?? 'visible'}`}`
    : `page shows "${tool.text ?? ''}"`;

/**
 * End-to-end verification in the conversation: runs the `app`, `browser_expect` and
 * `acceptance` tools, keeps the evidence of the turn (each browser step's screenshot, page
 * text and errors) and, at the end, has an independent reviewer judge the criteria.
 */
export class VerifyRuntime {
    private readonly _apps = new AppRunner();
    private _store: EvidenceStore | undefined;
    /** Errors since the last browser step, and on the page now (since it was opened). */
    private _sinceStep: string[] = [];
    private _onPage: string[] = [];
    private _reminders = 0;
    private _requestReminded = false;

    constructor(private readonly _host: VerifyHost) {
        _host.external.browser.onError = text => {
            this._host.passport().acceptance.consoleError(text);
            this._sinceStep.push(text); this._onPage.push(text);
        };
        _host.external.onBrowserStep = step => {
            // A page opened: what went wrong while it loaded belongs to it
            if (step.action === 'navigate') { this._onPage = [...this._sinceStep]; }
            this._sinceStep = [];
            const screenshot = this._store?.screenshot(step.screenshot, `${step.action}-${step.target}`);
            this._host.passport().acceptance.browserStep({ action: step.action, target: step.target, url: step.url, text: step.text, screenshot });
        };
    }

    /** A new turn: a new evidence folder (made only if something is saved). */
    beginTurn(workspaceRoot: string | undefined): void {
        this._store = new EvidenceStore(workspaceRoot);
        this._sinceStep = []; this._onPage = []; this._reminders = 0; this._requestReminded = false;
    }

    async run(tool: VerifyTool, msgId: string, signal: AbortSignal): Promise<string> {
        const post = this._host.post;
        const acceptance = this._host.passport().acceptance;
        switch (tool.type) {
            case 'app': {
                const label = tool.action === 'start' ? `${tool.url} — ${tool.command}` : tool.action;
                post({ type: 'toolStart', id: msgId, tool: 'app', label });
                if (tool.action === 'logs') { post({ type: 'toolResult', id: msgId, tool: 'app', label: 'logs', success: true }); return `[app logs]\n${this._apps.logs()}`; }
                if (tool.action === 'stop') { const n = this._apps.stop(); post({ type: 'toolResult', id: msgId, tool: 'app', label: 'stop', success: true }); return `[app stop] ${n ? `Stopped ${n} app${n === 1 ? '' : 's'}.` : 'No app was running.'}`; }
                const command = tool.command ?? ''; const url = tool.url ?? '';
                const sandbox = await commandSandbox();
                if (sandbox.refusal) { post({ type: 'toolResult', id: msgId, tool: 'app', label, success: false, error: 'No sandbox' }); return `[app start] ${sandbox.refusal}`; }
                if (!await this._host.tools.askToRun(command, msgId)) { post({ type: 'toolResult', id: msgId, tool: 'app', label, success: false, error: 'Denied' }); return `[app start] Denied by user:\n${command}`; }
                const seconds = Math.min(tool.timeoutSeconds ?? DEFAULT_APP_WAIT_SECONDS, MAX_APP_WAIT_SECONDS);
                post({ type: 'activity', text: `Waiting for ${url}…` });
                const started = await this._apps.start({ command, url, cwd: toolFolders()?.[0]?.uri.fsPath, timeoutMs: seconds * 1000, signal, wrap: sandbox.wrap });
                post({ type: 'activity', text: null });
                if (started.origin) { this._host.external.browser.allowOrigin(started.origin); }
                post({ type: 'toolResult', id: msgId, tool: 'app', label, success: started.ok, error: started.ok ? undefined : 'Did not start' });
                return `[app start: ${command}] ${started.text}`;
            }
            case 'browser_expect': {
                const description = describe(tool);
                post({ type: 'toolStart', id: msgId, tool: 'browser_expect', label: description });
                const browser = this._host.external.browser;
                const result = await browser.expect({ selector: tool.selector, text: tool.text, state: tool.state, timeoutMs: tool.timeoutMs })
                    .catch(error => ({ passed: false, detail: error instanceof Error ? error.message.split('\n')[0] : String(error) }));
                const shot = await browser.screenshot().catch(() => undefined);
                if (shot) { post({ type: 'browserScreenshot', id: msgId, dataUrl: `data:image/png;base64,${shot.toString('base64')}`, url: browser.currentUrl }); }
                const screenshot = shot ? this._store?.screenshot(shot, `expect-${description}`) : undefined;
                const errors = [...new Set(this._onPage)];
                const id = acceptance.addEvidence({ kind: 'expect', description, passed: result.passed, detail: result.detail, url: browser.currentUrl, consoleErrors: errors.slice(0, 5), screenshot });
                post({ type: 'toolResult', id: msgId, tool: 'browser_expect', label: `${description} — ${result.passed ? 'passed' : 'failed'} (${id})`, success: result.passed, error: result.passed ? undefined : 'Not as expected' });
                return `[browser_expect: ${description}] ${result.passed ? 'PASSED' : 'FAILED'}: ${result.detail}. Recorded as evidence ${id}.` +
                    (errors.length ? `\nErrors on this page so far (${errors.length}): ${errors.slice(0, 5).join(' | ')}` : '');
            }
            case 'acceptance': {
                post({ type: 'toolStart', id: msgId, tool: 'acceptance', label: tool.action === 'criteria' ? 'criteria' : `${tool.criterion} ${tool.result}` });
                if (tool.action === 'criteria') {
                    const listed = acceptance.setCriteria(tool.criteria ?? []);
                    const ok = !listed.startsWith('ERROR');
                    post({ type: 'toolResult', id: msgId, tool: 'acceptance', label: ok ? `${acceptance.criteria.length} criteria` : 'criteria', success: ok, error: ok ? undefined : 'No criteria' });
                    return ok ? `[acceptance criteria]\n${listed}\nCheck each on the final code, then record it with action "verify" and the evidence ids that show it.` : `[acceptance] ${listed}`;
                }
                const claimed = acceptance.claim(tool.criterion ?? '', tool.result ?? 'pass', tool.how ?? '', tool.evidence ?? []);
                post({ type: 'toolResult', id: msgId, tool: 'acceptance', label: `${tool.criterion} ${tool.result}`, success: claimed.ok, error: claimed.ok ? undefined : 'Not recorded' });
                return `[acceptance verify] ${claimed.text}`;
            }
        }
    }

    /** Once per turn, before a reply that changed code may end: that the request itself is met (requestCheck.ts). */
    private _requestGuidance(): string | undefined {
        if (this._requestReminded) { return undefined; }
        const text = requestCheckGuidance(this._host.passport().build());
        if (text) { this._requestReminded = true; }
        return text;
    }

    /** Before the reply may end: the criteria not verified on the final code, as a reminder; undefined when there is nothing to say. */
    guidance(): string | undefined {
        if (this._reminders >= MAX_ACCEPTANCE_REMINDERS) { return undefined; }
        const request = this._requestGuidance();
        if (request) { return request; }
        const report = this._host.passport().acceptance.build(this._host.passport().lastChange);
        // Failing criteria too: a reply must not present the work as complete while one fails
        const pending = report?.criteria.filter(c => c.status !== 'verified') ?? [];
        if (pending.length === 0) { return undefined; }
        this._reminders++;
        return `[System Acceptance] Not verified on the final code yet:\n${pending.map(criterionLine).join('\n')}\n` +
            'Check each with evidence Codico observes (browser_expect on the running app, or a test that exercises it) and record it with acceptance verify. ' +
            'If one cannot be checked or is not met, record it as failing or say so plainly in your answer; do not present the work as complete.';
    }

    /**
     * The end of the turn: the apps it started are stopped, and an independent reviewer judges
     * the criteria on the evidence alone (one request without tools, and none of the agent's reasoning).
     */
    async endTurn(reviewer: SubagentHost | undefined, enabled: boolean, signal: AbortSignal): Promise<void> {
        this._apps.stop();
        const passport = this._host.passport();
        // The report names where its screenshots are
        passport.acceptance.evidenceFolder = this._store?.folder;
        const report = passport.acceptance.build(passport.lastChange);
        if (!enabled || !reviewer || signal.aborted || !report || !report.criteria.some(c => c.status === 'verified' || c.status === 'claimed')) { return; }
        this._host.post({ type: 'activity', text: 'Reviewing acceptance…' });
        try {
            const built = passport.build();
            const diffStat = (built?.files ?? []).map(file => `${file.path} +${file.added} -${file.removed}`).join('\n');
            let text = '';
            for await (const chunk of reviewer.request([{ role: 'user', content: reviewPrompt(report, passport.acceptance.steps, diffStat) }], REVIEW_SYSTEM, [])) {
                if (signal.aborted) { return; }
                if (chunk.type === 'content') { text += chunk.text; } else if (chunk.type === 'usage') { reviewer.onUsage?.(chunk); }
            }
            for (const [id, review] of parseReview(text)) { passport.acceptance.setReview(id, review); }
        } catch { /* the report stands without the review: it says none was given */ } finally {
            this._host.post({ type: 'activity', text: null });
        }
    }

    /** Saves the report next to the screenshots, with the replay, when the turn saved any. */
    finish(reportMarkdown: string): void {
        if (this._store?.folder) { this._store.finish(reportMarkdown); }
    }

    /** The panel's "open the evidence" buttons. True when the message was one. */
    async route(message: WebviewMessage): Promise<boolean> {
        if (message.type !== 'openEvidence') { return false; }
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const relative = path.normalize(message.path);
        // Only a file in the evidence folder: the path comes from the panel
        if (!root || !relative.startsWith(EVIDENCE_DIR + path.sep) || relative.includes('..')) { return true; }
        const uri = vscode.Uri.file(path.join(root, relative));
        if (relative.endsWith('.md')) { await vscode.commands.executeCommand('markdown.showPreview', uri); }
        else { await vscode.commands.executeCommand('vscode.open', uri); }
        return true;
    }

    /** Stops everything it started (the window closes, or the conversation is cleared). */
    dispose(): void { this._apps.stop(); }
}

