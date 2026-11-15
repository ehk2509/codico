import { getNativeToolDefinitions } from './nativeTools';

/**
 * The reply of a headless run as a person or a script should read it. While the model works, its
 * tool calls arrive as fenced blocks (```run_terminal …```, ```acceptance …```) mixed into the text
 * the panel shows; printed raw they bury the answer in fragments like "```acceptance```acceptance".
 * Only Codico's own tool fences are removed: a code block in an answer (```js …```) is kept.
 */

/** Every tool the model can call by name, so its fence is recognised. */
const TOOL_NAMES: readonly string[] = [...new Set([...getNativeToolDefinitions(false, true).map(tool => tool.name), 'acceptance', 'app', 'browser_expect'])]
    .sort((a, b) => b.length - a.length);
const NAMES = TOOL_NAMES.join('|');

// A whole block: its header, any body, and a closing fence on a line of its own that is not itself the header of another block
const COMPLETE_BLOCK = new RegExp('`{3,}(?:' + NAMES + ')\\b[^\\n]*(?:\\n[\\s\\S]*?)?\\n`{3,}(?![A-Za-z_])', 'g');
// A header on its own: Codico hides the bodies of tool fences when it streams, and what is left over is headers
// (a model that repeats its header line leaves one behind). An open block's body is never streamed, so it needs no rule
const BARE_HEADER = new RegExp('`{3,}(?:' + NAMES + ')\\b', 'g');
// The end of the text may be the start of a fence that has not arrived yet ("``", "```acce")
const PARTIAL_TAIL = /`+[a-z_]*$/;

/** The text with tool markup removed; `final` also drops what could still have become a fence. */
export function cleanReply(raw: string, final: boolean): string {
    let text = raw.replace(COMPLETE_BLOCK, '').replace(BARE_HEADER, '');
    if (!final) { text = text.replace(PARTIAL_TAIL, ''); }
    return text.replace(/\n{3,}/g, '\n\n');
}

/** Turns a stream of reply pieces into a stream of cleaned pieces. */
export class ReplyCleaner {
    private _raw = '';
    private _emitted = '';

    /** Adds a piece; returns the new clean text it made available (possibly nothing). */
    push(piece: string): string {
        this._raw += piece;
        return this._advance(cleanReply(this._raw, false));
    }

    /** The reply is complete: whatever was held back. */
    flush(): string {
        return this._advance(cleanReply(this._raw, true));
    }

    /** A new reply starts. */
    reset(): void { this._raw = ''; this._emitted = ''; }

    private _advance(view: string): string {
        // Removing markup never changes text already shown; if it somehow would, wait for the end rather than repeat anything
        if (!view.startsWith(this._emitted)) { return ''; }
        const fresh = view.slice(this._emitted.length);
        this._emitted = view;
        return fresh;
    }
}
