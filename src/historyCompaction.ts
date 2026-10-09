import { ChatMessage, MessageContentPart } from './openRouterClient';

/**
 * History compaction planning. The user's current request must survive
 * compaction verbatim, the summary must prefer recent work, and the kept tail
 * must never start inside a tool exchange (a tool result whose call was cut
 * off is rejected by strict providers and leaves the model without context).
 */

export const SUMMARY_PREFIX = '[Conversation Summary]';
/** Separates Codico's injected [Context] block from the text the user actually wrote. */
export const USER_REQUEST_MARKER = '[User request]';
const SUMMARY_ACK = 'Understood. I have the summary of the earlier work and will continue from it.';

export interface CompactionPlan {
    /** Conversation before the current request; folded into the summary. */
    earlier: ChatMessage[];
    /** Older part of a long current turn; folded into the summary. */
    progress: ChatMessage[];
    /** The user's current request, kept verbatim (null if none can be identified). */
    request: ChatMessage | null;
    /** Most recent complete exchanges of the current turn, kept verbatim. */
    tail: ChatMessage[];
}

export interface CompactionOptions {
    /** Assistant steps (with their tool results) of the current turn to keep verbatim. */
    maxTailExchanges?: number;
    /** Size cap for the kept tail; at least the last exchange is always kept. */
    maxTailChars?: number;
}

export function messageText(message: ChatMessage): string {
    const content = message.content;
    if (typeof content === 'string') { return content; }
    return (content as MessageContentPart[])
        .filter(part => part.type === 'text')
        .map(part => (part as { type: 'text'; text: string }).text)
        .join('');
}

/** A message the user wrote (not a tool result, a Codico reminder or an earlier summary). */
export function isUserRequest(message: ChatMessage): boolean {
    if (message.role !== 'user') { return false; }
    const text = messageText(message).trimStart();
    return !text.startsWith('[Tool Results]') && !text.startsWith('[System') && !text.startsWith(SUMMARY_PREFIX);
}

function size(message: ChatMessage): number {
    const calls = message.role === 'assistant' && message.nativeToolCalls ? JSON.stringify(message.nativeToolCalls).length : 0;
    return messageText(message).length + calls;
}

/** Returns null when there is nothing worth compacting. */
export function planCompaction(history: ChatMessage[], options: CompactionOptions = {}): CompactionPlan | null {
    const maxTailExchanges = Math.max(1, options.maxTailExchanges ?? 4);
    const maxTailChars = Math.max(1, options.maxTailChars ?? 60_000);

    let requestIndex = -1;
    for (let i = history.length - 1; i >= 0; i--) {
        if (isUserRequest(history[i])) { requestIndex = i; break; }
    }

    const earlier = requestIndex > 0 ? history.slice(0, requestIndex) : [];
    const request = requestIndex >= 0 ? history[requestIndex] : null;
    const turn = history.slice(requestIndex + 1);

    // Exchanges start at assistant messages; the tail may only begin at one of them
    const exchangeStarts: number[] = [];
    turn.forEach((message, index) => { if (message.role === 'assistant') { exchangeStarts.push(index); } });

    let tailStart = turn.length;
    let tailChars = 0;
    let kept = 0;
    for (let e = exchangeStarts.length - 1; e >= 0 && kept < maxTailExchanges; e--) {
        const start = exchangeStarts[e];
        const end = e + 1 < exchangeStarts.length ? exchangeStarts[e + 1] : turn.length;
        const chars = turn.slice(start, end).reduce((sum, m) => sum + size(m), 0);
        if (kept > 0 && tailChars + chars > maxTailChars) { break; }
        tailStart = start;
        tailChars += chars;
        kept++;
    }

    const progress = turn.slice(0, tailStart);
    const tail = turn.slice(tailStart);
    if (earlier.length === 0 && progress.length === 0) { return null; }
    return { earlier, progress, request, tail };
}

function describe(message: ChatMessage, maxChars: number): string {
    let label = message.role.toUpperCase();
    let text = messageText(message);
    if (message.role === 'tool') { label = `TOOL RESULT (${message.toolName})`; }
    if (message.role === 'assistant' && message.nativeToolCalls?.length) {
        text += '\n[tool calls: ' + message.nativeToolCalls.map(c => `${c.name} ${JSON.stringify(c.arguments)}`).join('; ') + ']';
    }
    if (text.length > maxChars) { text = text.slice(0, maxChars) + '\n… (truncated)'; }
    return `### ${label}\n${text}`;
}

/** Newest-first within the budget, returned oldest-first: recent work wins when space is short. */
function recentFirst(messages: ChatMessage[], budget: number, perMessage: number): string {
    const parts: string[] = [];
    let used = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const part = describe(messages[i], perMessage);
        if (used + part.length > budget) {
            if (parts.length === 0) { parts.push(part.slice(0, budget)); }
            break;
        }
        parts.push(part);
        used += part.length;
    }
    const omitted = messages.length - parts.length;
    return (omitted > 0 ? `(${omitted} older message(s) omitted)\n\n` : '') + parts.reverse().join('\n\n---\n\n');
}

/** The user's own words without Codico's injected [Context] block, capped at maxChars. */
export function userRequestText(message: ChatMessage, maxChars = 2000): string {
    const text = messageText(message);
    const marker = text.indexOf(USER_REQUEST_MARKER + '\n');
    if (marker >= 0) { return text.slice(marker + USER_REQUEST_MARKER.length + 1).slice(0, maxChars); }
    // Older messages have no marker; the user's text is at the end, after the context
    if (text.startsWith('[Context]')) { return (text.length > maxChars ? '\u2026' : '') + text.slice(-maxChars); }
    return text.slice(0, maxChars);
}

export function summarizerPrompt(plan: CompactionPlan, budget = 40_000): string {
    const progressBudget = plan.progress.length ? (plan.earlier.length ? Math.floor(budget * 0.4) : budget) : 0;
    const earlierBudget = budget - progressBudget;
    const sections = [
        'You are summarising a coding assistant conversation so the assistant can continue with less context. ' +
        'Produce a concise but complete summary preserving: files created, modified or deleted (with paths); key decisions and constraints; ' +
        'important facts discovered about the code; errors and how they were resolved; and anything still outstanding. ' +
        'The user\'s current request is shown for reference and is kept separately, verbatim, so do not restate it: ' +
        'focus on what is relevant to continuing it. Prefer recent information. Write in past tense.',
    ];
    if (plan.request) { sections.push('## Current request (kept separately)\n' + userRequestText(plan.request)); }
    // The transcript is delimited and the instruction repeated after it: models given a long
    // transcript last tend to continue it in its own format instead of summarising it
    const transcript: string[] = [];
    if (plan.earlier.length) { transcript.push('## Earlier conversation (oldest first)\n' + recentFirst(plan.earlier, earlierBudget, 3000)); }
    if (plan.progress.length) { transcript.push('## Progress so far on the current request (oldest first)\n' + recentFirst(plan.progress, progressBudget, 3000)); }
    sections.push('<transcript>\n' + transcript.join('\n\n') + '\n</transcript>');
    sections.push(SUMMARY_INSTRUCTION);
    return sections.join('\n\n');
}

const SUMMARY_INSTRUCTION = 'Now write the summary of the transcript above, in your own words: short paragraphs and bullet points ' +
    'covering files changed, decisions, facts found, errors and what is still outstanding. Do not continue the conversation, ' +
    'do not call tools, and do not copy its messages or its "### ROLE" / "[tool calls: …]" format.';

/** Why a summary must not replace the history, or null when it is usable. */
export function summaryProblem(summary: string, plan: CompactionPlan): string | null {
    const text = summary.trim();
    if (!text) { return 'the summary was empty'; }
    if (/^###\s+(USER|ASSISTANT|TOOL RESULT)\b/m.test(text) || text.includes('[tool calls: ') || /^\[Tool Results\]/m.test(text)) {
        return 'the model copied the transcript instead of summarising it';
    }
    const replaced = [...plan.earlier, ...plan.progress].reduce((sum, m) => sum + size(m), 0);
    if (replaced > 20_000 && text.length < 150) { return 'the summary was too short for what it would replace'; }
    return null;
}

/** Roles alternate: summary (user) → ack (assistant) → request (user) → tail (starts with assistant). */
export function buildCompactedHistory(summary: string, plan: CompactionPlan): ChatMessage[] {
    const compacted: ChatMessage[] = [{ role: 'user', content: `${SUMMARY_PREFIX}\n\n${summary.trim()}` }];
    if (plan.request) { compacted.push({ role: 'assistant', content: SUMMARY_ACK }, plan.request); }
    return [...compacted, ...plan.tail];
}

/**
 * Once a plan is approved, the plan itself is what execution needs. The tool steps that
 * led to it (mostly file reads) would otherwise be resent with every execution request.
 * Keeps the plan request and the final plan; drops the steps in between. Returns the
 * history unchanged unless it ends with the reply to a plan request.
 */
export function dropPlanningSteps(history: ChatMessage[], planPromptStart: string): { history: ChatMessage[]; droppedChars: number } {
    const unchanged = { history, droppedChars: 0 };
    const last = history.length - 1;
    const plan = history[last];
    if (!plan || plan.role !== 'assistant' || plan.nativeToolCalls?.length) { return unchanged; }
    let request = -1;
    for (let i = last - 1; i >= 0; i--) {
        if (isUserRequest(history[i])) { request = i; break; }
    }
    if (request < 0 || !userRequestText(history[request], planPromptStart.length).startsWith(planPromptStart)) { return unchanged; }
    const steps = history.slice(request + 1, last);
    if (steps.length === 0) { return unchanged; }
    const droppedChars = steps.reduce((sum, m) => sum + size(m), 0);
    return { history: [...history.slice(0, request + 1), plan], droppedChars };
}

/** The history and prompt to execute an approved plan with: without the planning steps, and saying so. */
export function approvedPlanExecution(history: ChatMessage[], planPromptStart: string, executionPrompt: string): { history: ChatMessage[]; prompt: string } {
    const slim = dropPlanningSteps(history, planPromptStart);
    return slim.droppedChars
        ? { history: slim.history, prompt: `${executionPrompt}\n\n(The files read while planning are no longer in context, to save tokens. Re-read what you need before editing it.)` }
        : { history, prompt: executionPrompt };
}
