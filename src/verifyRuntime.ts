import { changedPart, criterionLine, parseReview, reviewPrompt } from './acceptance';
import { AppRunner } from './appRunner';
import { commandSandbox } from './commandSandboxService';
import { ExtensionMessage, WebviewMessage } from './chatProtocol';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { EVIDENCE_DIR, EvidenceStore } from './evidenceStore';
import { ExternalToolRuntime } from './externalToolRuntime';
import { PassportRecorder } from './patchPassport';
import { SubagentHost } from './subagent';
import { toolFolders } from './toolRoot';
import { VerifyTool, BrowserExpectTool } from './verifyTools';
import { requestCheckGuidance } from './requestCheck';
import { isDocumentationFile, isTestFile } from './agentEfficiency';
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
/** Times a disputed acceptance goes back to the agent before the reply may end with it. */
export const MAX_REVIEW_DISPUTES = 2;
/** How a reviewer's dispute starts: the agent loop may hand the turn to a stronger model on it. */
export const REVIEW_DISPUTE_PREFIX = '[System Acceptance] An independent reviewer';
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
    /** What the last review saw (the code and evidence then), and whether its objections were given to the agent. */
    private _reviewedState = '';
    private _disputes = 0;
    /** The code and evidence when the last dispute was given: another is given only after the agent worked on it. */
    private _disputedState = '';
    /** The user's request of this turn, for the reviewer. */
    private _request = '';

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
    beginTurn(workspaceRoot: string | undefined, request = ''): void {
        this._request = request;
        this._store = new EvidenceStore(workspaceRoot);
        this._sinceStep = []; this._onPage = []; this._reminders = 0; this._requestReminded = false; this._reviewedState = ''; this._disputes = 0; this._disputedState = '';
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

    /** The turn changed code, not only documentation. */
    changedCode(): boolean {
        return (this._host.passport().build()?.files ?? []).some(file => !isDocumentationFile(file.path));
    }

    /** The turn changed code (not only documentation) and the acceptance is not established. */
    unfinished(): boolean {
        const passport = this._host.passport().build();
        const code = passport?.files.filter(file => !isDocumentationFile(file.path)) ?? [];
        return code.length > 0 && passport?.acceptance?.verdict !== 'accepted';
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
     * Before the reply may end: the reminders above, and then the independent review. A criterion
     * the reviewer does not agree is shown goes back to the agent, once, with the reviewer's reason,
     * so the reply does not present as done what the review disputes.
     */
    async guidanceBeforeEnd(reviewer: SubagentHost | undefined, enabled: boolean, signal: AbortSignal): Promise<string | undefined> {
        const reminder = this.guidance();
        if (reminder || !enabled || this._disputes >= MAX_REVIEW_DISPUTES) { return reminder; }
        if (!reviewer) {
            if (this.changedCode()) { this._host.passport().acceptance.setReview('REQUEST', { agrees: false, reason: 'Independent acceptance review unavailable.' }); }
            return undefined;
        }
        // The agent changed nothing since the last dispute (it answered it, or gave up): no point repeating it
        if (this._disputes > 0 && this._state() === this._disputedState) { return undefined; }
        // Reviewed again only when the code or the evidence changed since the last review
        if (this._state() !== this._reviewedState) { await this._review(reviewer, signal); }
        const report = this._host.passport().acceptance.build(this._host.passport().lastChange);
        const disputed = (report?.criteria.filter(c => c.review?.agrees === false) ?? []).map(c => `${c.id} ${c.text} — ${c.review?.reason ?? ''}`);
        if (report?.requestReview?.agrees === false) { disputed.push(`The request as the user asked it is not covered — ${report.requestReview.reason}`); }
        if (disputed.length === 0) { return undefined; }
        this._disputes++;
        this._disputedState = this._state();
        return `${REVIEW_DISPUTE_PREFIX}, who saw only the user's request, the evidence and your tests, does not agree that these are shown on the final code:\n` +
            disputed.join('\n') +
            '\nShow each with a test that checks exactly what the criterion says (the exact result, the user\'s own case), or say plainly in your answer that it is not met. Do not present the work as complete otherwise.';
    }

    /**
     * The end of the turn: the apps it started are stopped, and the criteria are reviewed again
     * when the code or the evidence changed since the last review.
     */
    async endTurn(reviewer: SubagentHost | undefined, enabled: boolean, signal: AbortSignal): Promise<void> {
        this._apps.stop();
        const passport = this._host.passport();
        // The report names where its screenshots are
        passport.acceptance.evidenceFolder = this._store?.folder;
        if (enabled && !reviewer && this.changedCode()) { passport.acceptance.setReview('REQUEST', { agrees: false, reason: 'Independent acceptance review unavailable.' }); }
        if (enabled && reviewer && this._state() !== this._reviewedState) { await this._review(reviewer, signal); }
    }

    /** The code and the evidence the criteria rest on: a review is current while they have not changed. */
    private _state(): string {
        const passport = this._host.passport();
        const report = passport.acceptance.build(passport.lastChange);
        return `${passport.lastChange}:${passport.acceptance.evidence.length}:${report?.criteria.map(c => `${c.id}=${c.status}`).join(',') ?? ''}`;
    }

    /** The independent reviewer judges the criteria on the evidence and the agent's tests alone (one request without tools, and none of the agent's reasoning). */
    private async _review(reviewer: SubagentHost, signal: AbortSignal): Promise<void> {
        const passport = this._host.passport();
        const report = passport.acceptance.build(passport.lastChange);
        if (signal.aborted || !report || !report.criteria.some(c => c.status === 'verified' || c.status === 'claimed')) { return; }
        this._reviewedState = this._state();
        this._host.post({ type: 'activity', text: 'Reviewing acceptance…' });
        try {
            const built = passport.build();
            const diffStat = (built?.files ?? []).map(file => `${file.path} +${file.added} -${file.removed}`).join('\n');
            let text = '';
            for await (const chunk of reviewer.request([{ role: 'user', content: reviewPrompt(report, passport.acceptance.steps, diffStat, this._testsChanged(built?.files.map(f => f.path) ?? []), this._request, this._sourcesChanged(built?.files.map(f => f.path) ?? [])) }], REVIEW_SYSTEM, [])) {
                if (signal.aborted) { return; }
                if (chunk.type === 'content') { text += chunk.text; } else if (chunk.type === 'usage') { reviewer.onUsage?.(chunk); }
            }
            const reviews = parseReview(text);
            for (const [id, review] of reviews) { passport.acceptance.setReview(id, review); }
            // Incomplete review output must never silently count as approval.
            if (this._request.trim() && !reviews.has('REQUEST')) {
                passport.acceptance.setReview('REQUEST', { agrees: false, reason: 'Reviewer did not confirm coverage of the original request.' });
            }
            for (const criterion of report.criteria.filter(c => c.status === 'verified')) {
                if (!reviews.has(criterion.id)) { passport.acceptance.setReview(criterion.id, { agrees: false, reason: 'Reviewer did not confirm this criterion.' }); }
            }
        } catch {
            if (this._request.trim()) { passport.acceptance.setReview('REQUEST', { agrees: false, reason: 'Independent acceptance review failed; request remains unverified.' }); }
        } finally {
            this._host.post({ type: 'activity', text: null });
        }
    }

    /** Show the reviewer what was actually changed in production, not just a file list. */
    private _sourcesChanged(paths: string[]): Array<{ path: string; text: string }> {
        const root = toolFolders()?.[0]?.uri.fsPath;
        if (!root) { return []; }
        return paths.filter(p => !isTestFile(p) && !isDocumentationFile(p)
            && /\.(?:[cm]?[jt]sx?|py|go|rs)$/.test(p)).slice(0, 6).flatMap(p => {
            try {
                const text = fs.readFileSync(path.isAbsolute(p) ? p : path.join(root, p), 'utf8');
                return [{ path: p, text: changedPart(this._host.passport().beforeOf(p), text, 12000, 12) }];
            } catch { return []; }
        });
    }

    /** The test files changed in the turn, as they are now: what the evidence's assertions really check (at most three, each the part the turn changed). */
    private _testsChanged(paths: string[]): Array<{ path: string; text: string }> {
        const root = toolFolders()?.[0]?.uri.fsPath;
        if (!root) { return []; }
        return paths.filter(p => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go)$|(^|\/)test_[^/]*\.py$/.test(p.replace(/\\/g, '/'))).slice(0, 3).flatMap(p => {
            try {
                const text = fs.readFileSync(path.isAbsolute(p) ? p : path.join(root, p), 'utf8');
                return [{ path: p, text: changedPart(this._host.passport().beforeOf(p), text) }];
            } catch { return []; }
        });
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

