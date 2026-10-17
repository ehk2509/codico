/**
 * The tools of end-to-end verification: `app` starts the project's app, `browser_expect`
 * checks the page (Codico's own assertion, recorded as evidence) and `acceptance` states the
 * criteria of the request and says which evidence shows each one. Formats and prompt only.
 */

/** Starts, stops or reads the log of an app on this machine. */
export interface AppTool {
    type: 'app';
    action: 'start' | 'stop' | 'logs';
    command?: string;
    url?: string;
    timeoutSeconds?: number;
}

/** An assertion on the browser page, run by Codico. */
export interface BrowserExpectTool {
    type: 'browser_expect';
    selector?: string;
    text?: string;
    state?: 'visible' | 'hidden' | 'exists' | 'absent';
    timeoutMs?: number;
}

/** The criteria of the request, or whether one of them is met and on which evidence. */
export interface AcceptanceTool {
    type: 'acceptance';
    action: 'criteria' | 'verify';
    criteria?: string[];
    criterion?: string;
    result?: 'pass' | 'fail';
    evidence?: string[];
    how?: string;
}

export type VerifyTool = AppTool | BrowserExpectTool | AcceptanceTool;
export const VERIFY_TOOL_NAMES = ['app', 'browser_expect', 'acceptance'] as const;

const str = (args: Record<string, unknown>, key: string) => typeof args[key] === 'string' && (args[key] as string).trim() ? (args[key] as string).trim() : undefined;
const num = (args: Record<string, unknown>, key: string) => { const n = typeof args[key] === 'number' ? args[key] as number : Number(str(args, key)); return Number.isFinite(n) && n > 0 ? n : undefined; };
const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map(v => v.trim())
    : typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : [];

/** A call from the model's arguments (native tool calling, or the fields of the fenced form). */
export function verifyToolFromArgs(name: string, args: Record<string, unknown>): VerifyTool | null {
    switch (name) {
        case 'app': {
            const action = str(args, 'action')?.toLowerCase() ?? (str(args, 'command') ? 'start' : '');
            if (action !== 'start' && action !== 'stop' && action !== 'logs') { return null; }
            if (action === 'start' && (!str(args, 'command') || !str(args, 'url'))) { return null; }
            return { type: 'app', action, ...(str(args, 'command') ? { command: str(args, 'command') } : {}), ...(str(args, 'url') ? { url: str(args, 'url') } : {}),
                ...(num(args, 'timeout_seconds') ? { timeoutSeconds: num(args, 'timeout_seconds') } : {}) };
        }
        case 'browser_expect': {
            const state = str(args, 'state')?.toLowerCase();
            const tool: BrowserExpectTool = { type: 'browser_expect', ...(str(args, 'selector') ? { selector: str(args, 'selector') } : {}),
                ...(typeof args.text === 'string' && args.text !== '' ? { text: args.text } : {}),
                ...(state === 'visible' || state === 'hidden' || state === 'exists' || state === 'absent' ? { state } : {}),
                ...(num(args, 'timeout_ms') ? { timeoutMs: num(args, 'timeout_ms') } : {}) };
            return tool.selector || tool.text ? tool : null;
        }
        case 'acceptance': {
            const action = str(args, 'action')?.toLowerCase();
            if (action === 'criteria') {
                const criteria = Array.isArray(args.criteria) ? list(args.criteria) : (str(args, 'criteria') ?? '').split('\n').map(line => line.replace(/^\s*(?:[-*•]|\d+[.)]|AC\d+:)\s*/i, '').trim()).filter(Boolean);
                return criteria.length ? { type: 'acceptance', action, criteria } : null;
            }
            if (action === 'verify') {
                const result = str(args, 'result')?.toLowerCase();
                const criterion = str(args, 'criterion');
                if (!criterion || (result !== 'pass' && result !== 'fail')) { return null; }
                return { type: 'acceptance', action, criterion, result, evidence: list(args.evidence), how: str(args, 'how') ?? '' };
            }
            return null;
        }
    }
    return null;
}

/** The fenced form: "key: value" lines; "criteria:" and "how:" run to the end of the block. */
export function parseVerifyFence(name: string, body: string): VerifyTool | null {
    const args: Record<string, unknown> = {};
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^\s*([a-z_]+)\s*:\s*(.*)$/);
        if (!match) { continue; }
        if (match[1] === 'criteria' || match[1] === 'how') { args[match[1]] = [match[2], ...lines.slice(i + 1)].join('\n').trim(); break; }
        // Text to find is kept as written, spaces included
        args[match[1]] = match[1] === 'text' ? match[2].replace(/^"(.*)"$/, '$1') : match[2].trim();
    }
    return verifyToolFromArgs(name, args);
}

export const APP_TOOL_DESCRIPTION = 'Start the project\'s app on this machine so it can be checked in the browser (a dev server keeps running, which run_terminal cannot do), stop it, or read its log. ' +
    'action "start" needs command (e.g. "npm run dev -- --port 5173") and url (the local address it serves, e.g. http://localhost:5173); it waits until the address answers. The app stops when the task ends. The browser may open that address.';
export const BROWSER_EXPECT_DESCRIPTION = 'Check the current browser page; Codico runs the check itself and records the result as evidence (E1, E2…) for the acceptance criteria. ' +
    'With selector and text: the element shows the text. With text alone: the page shows it. With selector and state: visible, hidden, exists or absent. It waits up to timeout_ms (5000) for the page to update. Console errors seen on the page are reported.';
export const ACCEPTANCE_DESCRIPTION = 'Acceptance criteria of the request. action "criteria": state them (criteria: list), at the start of a feature or a fix: concrete, observable outcomes, not "the code compiles". ' +
    'action "verify": say whether one is met (criterion: AC1, result: pass or fail, evidence: ids of browser_expect results and test commands that show it, how: what you did). ' +
    'A criterion counts as verified only on evidence Codico observed after the last code change. ' +
    'A test command can name the criteria it shows instead (run_terminal verifies: AC1 AC2): Codico records them on its result.';

/** What the agent is told about verifying its work end to end. */
export const VERIFY_PROMPT_SECTION = `[Acceptance]
A passing build or test run shows that the code works, not that the request is met. For a feature or a bug fix:
1. State the acceptance criteria first (acceptance, action "criteria"): what the user will be able to see or do.
2. For a bug, reproduce it before changing the code, and record the failure (acceptance verify, result fail, with the evidence).
3. After the change, check each criterion on the final code. For a web app: start it (app, action "start"), drive it with the browser tools, and assert what the user should see with browser_expect. Otherwise run a test that exercises the criterion.
4. Record each criterion with acceptance verify, naming the evidence ids (E1, E2…) of the browser_expect results and test commands that show it. For a test, name the criteria in the command itself (run_terminal verifies: AC1 AC2): when it passes Codico records them as met on its result, so no separate acceptance verify is needed. Look at console errors the browser reports.
5. Report plainly which criteria are verified and which are not. Never call a feature done because it builds.
Fenced forms:
\`\`\`app
action: start
command: npm run dev -- --port 5173
url: http://localhost:5173
\`\`\`
\`\`\`browser_expect
selector: .cart-total
text: $42.00
\`\`\`
\`\`\`acceptance
action: criteria
criteria:
- Changing the quantity updates the cart total
- An empty cart shows "Your cart is empty"
\`\`\`
\`\`\`run_terminal
command: npm test
verifies: AC1 AC2
\`\`\`
\`\`\`acceptance
action: verify
criterion: AC1
result: pass
evidence: E3 E4
how: set quantity to 3 in the browser; the total showed $42.00
\`\`\``;
