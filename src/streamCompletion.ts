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
    return ACTION_ANNOUNCEMENT_RE.test(lastParagraph);
}

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
