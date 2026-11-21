import type { ClientRequest } from 'http';

export class StreamCompletionGuard {
    private _terminalSeen = false;

    markTerminal(): void {
        this._terminalSeen = true;
    }

    get terminalSeen(): boolean {
        return this._terminalSeen;
    }

    unexpectedEofMessage(provider: string): string | null {
        if (this._terminalSeen) { return null; }
        return `${provider} stream interrupted: connection closed before the provider sent a completion marker.`;
    }
}

let streamStallMs = 300_000;

/** Silence after which a streaming request counts as dropped (setting codico.streamStallTimeoutSeconds). */
export function setStreamStallTimeout(seconds: number): void {
    streamStallMs = Math.max(1, seconds) * 1000;
}

/**
 * A provider that keeps the connection open but stops sending would hang the turn
 * until the user presses Stop. After a silence the connection is dropped instead,
 * which surfaces as a transport error and goes through the normal reconnect.
 */
export function watchStreamStall(req: ClientRequest): void {
    const ms = streamStallMs;
    req.setTimeout(ms, () => req.destroy(new Error(`no data received for ${Math.round(ms / 1000)} s (stalled)`)));
}

export function isRecoverableStreamInterruption(message: string): boolean {
    return /stream interrupted: connection closed before|stream transport error:/i.test(message);
}

export function normalizeFinishReason(reason: string): string {
    const normalized = reason.trim().toLowerCase();
    if (normalized === 'max_tokens' || normalized === 'max_output_tokens' || normalized === 'max_tokens_reached') {
        return 'length';
    }
    if (normalized === 'safety' || normalized === 'recitation' || normalized === 'blocked') {
        return 'content_filter';
    }
    return normalized;
}

/**
 * A closing offer ("If you meant X, let me know and I'll adjust it") or a statement that the work
 * is done: what it says the agent would do depends on the user, so it is not an unfinished step.
 */
const OFFER_OR_DONE_RE = /\b(?:if (?:you|that|this|needed|necessary|wanted|preferred)|let me know|just (?:say|tell|ask)|feel free|should you|happy to|would you like|want me to)\b|\b(?:task|work|change|fix) (?:is|was) (?:complete|completed|done|finished)\b|^\s*(?:final answer|done)\b/i;

/**
 * True when a reply ends by offering to go on or asking how to proceed ("Say the word and I'll
 * start", "Which do you want?"): the agent stopped and handed the decision back.
 */
export function endsWithOfferOrQuestion(content: string): boolean {
    const text = content.trim();
    if (!text || text.includes('<clarify>')) { return false; }
    const lastParagraph = text.split(/\n\s*\n/).pop() ?? '';
    return /\?\s*$/.test(lastParagraph) || /\b(?:say the word|let me know|want me to|would you like|shall I|should I|if you(?:'d| would) like|I can (?:also )?(?:do|start|continue|finish|wire|add|implement))\b/i.test(lastParagraph);
}

const ACTION_ANNOUNCEMENT_RE = /\b(?:I['’]ll|I will|I['’]m going to|I am going to|let me|I['’]m (?:now )?(?:searching|locating|looking|checking|reading|opening|running|writing|creating|updating|fixing|inspecting))\b/i;

/**
 * True when a response with no tool call ends by announcing an action
 * ("I'll locate the file.") — the model stopped before emitting the tool fence.
 * Only the final paragraph is checked so a summary that mentions earlier steps
 * is not mistaken for an unfinished action.
 */
export function isUnfulfilledActionAnnouncement(content: string): boolean {
    const text = content.trim();
    if (!text || text.includes('<clarify>') || text.endsWith('?')) { return false; }
    const lastParagraph = text.split(/\n\s*\n/).pop() ?? '';
    if (lastParagraph.length > 300 || lastParagraph.includes('```')) { return false; }
    return ACTION_ANNOUNCEMENT_RE.test(lastParagraph) && !OFFER_OR_DONE_RE.test(lastParagraph);
}

/**
 * A tool call in a syntax other than Codico's fenced blocks, seen with models trained on XML calls
 * (`<invoke>`, `<tool_call>`, Qwen's `<function=read_file><parameter=...>`). Nothing runs for it.
 */
const PSEUDO_TOOL_CALL_RE = /<invoke\b|<function_calls>|<tool_call>|<tool_use>|<function=[\w.-]+>/;

/** True when the reply holds a tool call Codico cannot run (see PSEUDO_TOOL_CALL_RE). */
export function containsPseudoToolCall(content: string): boolean {
    return PSEUDO_TOOL_CALL_RE.test(content);
}

/** Sent back after a pseudo tool call: nothing ran, and any results the model wrote are made up. */
export const PSEUDO_TOOL_CALL_CORRECTION = '[System] That was not a tool call Codico can run, so nothing was executed and any results you wrote are not real. ' +
    'Call tools only with the fenced code block formats from the instructions (for example a block opened with ```read_file), then wait for the real results.';

/** "I have what I need for the review.", "Here is my review:" — the answer is said to come next. */
// Anchored to the end of the sentence: "I have what I need, so here is the fix: …" is an answer.
const READY_TO_ANSWER_RE = new RegExp('(?:' + [
    String.raw`\bI (?:now )?have (?:what|everything|all|enough)\b[^.!?,;:]*\bneed(?:ed)?\b(?:\s+(?:for|to)\b[^.!?,;:]*)?`,
    String.raw`\b(?:that['’]s|that is|this is) (?:all|everything|enough) I need(?:ed)?\b(?:\s+(?:for|to)\b[^.!?,;:]*)?`,
    String.raw`\bI['’]m (?:now )?ready to (?:write|give|present|summari[sz]e|report|answer)\b[^.!?,;:]*`,
    String.raw`\bnow I can (?:write|give|present|summari[sz]e|report|answer)\b[^.!?,;:]*`,
    String.raw`^here(?:['’]s| is| are) (?:the|my) (?:review|summary|answer|report|findings)\b[^.!?:]*:`,
].join('|') + String.raw`)\s*[.!]?\s*$`, 'i');

/**
 * True when a reply with no tool call ends by saying the answer comes next ("I have what I need
 * for the review.") and stops there: the model ended its turn before writing the answer. Only the
 * last sentence counts, and a long reply is taken to be the answer.
 */
export function endsBeforeTheAnswer(content: string): boolean {
    const text = content.trim();
    if (!text || text.length > 1500 || text.includes('<clarify>')) { return false; }
    const lastParagraph = (text.split(/\n\s*\n/).pop() ?? '').trim();
    const lastSentence = (lastParagraph.split(/(?<=[.!])\s+/).pop() ?? '').trim();
    return READY_TO_ANSWER_RE.test(lastSentence);
}

/** Sent back once when a turn that ran tools ends without any text. */
export const NO_ANSWER_REMINDER = '[System] Your reply ended without any text. Give your final answer now: what you changed, how you checked it, and anything not done.';

/** Sent back once when a reply ends before its answer (endsBeforeTheAnswer). */
export const WRAP_UP_REMINDER = '[System] Your reply says you are ready to answer but ends before the answer, so the user has none. ' +
    'Write your complete final answer now, from what you have already found. Do not repeat the reads you already made.';

/** How much of the pre-cutoff text is compared against the start of a resumed response. */
export const RESUME_OVERLAP_WINDOW = 400;

/**
 * Length of the prefix of `continuation` that repeats the end of `previousTail`.
 * Resumed responses often restart the last sentence or paragraph; dropping the
 * overlap makes the resume invisible. Whitespace at the seam is ignored.
 */
export function repeatedPrefixLength(previousTail: string, continuation: string): number {
    const MIN_OVERLAP = 12;
    const lead = continuation.length - continuation.trimStart().length;
    const body = continuation.slice(lead);
    const tail = previousTail.trimEnd();
    for (let j = 0; j <= tail.length - MIN_OVERLAP; j++) {
        const suffix = tail.slice(j);
        if (body.startsWith(suffix)) { return lead + suffix.length; }
        // Continuation ended before reaching the cutoff point — it is all repetition
        if (body.length >= MIN_OVERLAP && suffix.startsWith(body)) { return continuation.length; }
    }
    return 0;
}

/**
 * Splits streamed text into reply content and `<think>` reasoning. A tag split
 * across chunks ("<thi" + "nk>") is held back until complete, so it never leaks
 * into the reply as raw text.
 */
export class ThinkTagSplitter {
    private _inThink = false;
    private _carry = '';

    constructor(private readonly _emit: (kind: 'content' | 'thinking', text: string) => void) {}

    push(text: string): void {
        let rest = this._carry + text;
        this._carry = '';
        for (;;) {
            const tag = this._inThink ? '</think>' : '<think>';
            const idx = rest.indexOf(tag);
            if (idx !== -1) {
                this._out(rest.slice(0, idx));
                this._inThink = !this._inThink;
                rest = rest.slice(idx + tag.length);
                continue;
            }
            // Keep back an ending that could be the start of the tag
            let keep = 0;
            for (let n = Math.min(tag.length - 1, rest.length); n > 0; n--) {
                if (tag.startsWith(rest.slice(-n))) { keep = n; break; }
            }
            this._out(rest.slice(0, rest.length - keep));
            this._carry = rest.slice(rest.length - keep);
            return;
        }
    }

    /** Emits anything still held back; call when the stream ends. */
    flush(): void {
        const carry = this._carry;
        this._carry = '';
        this._out(carry);
    }

    private _out(text: string): void {
        if (text) { this._emit(this._inThink ? 'thinking' : 'content', text); }
    }
}
