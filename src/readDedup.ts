import { ChatMessage } from './openRouterClient';

/**
 * Keeps a file read from repeating text the model already has. Nothing is remembered
 * between calls: the conversation itself is searched for earlier numbered text of the file
 * (reads, and the snippets edits return), and a line counts as known only if that text is
 * still there and still equal to the file. So a file that changed, a conversation that was
 * compacted or cut back, or another thread never hide anything.
 */

/** Runs of known lines shorter than this are sent anyway: a gap marker would save nothing. */
export const MIN_OMITTED_RUN = 8;

const HEADER_RE = /\[(?:read_file: ([^\n\]]+?) lines \d+–\d+ of \d+[^\n\]]*|edit_file: ([^\n\]]+?))\]/g;
const NOT_REPEATED = 'Not repeated';

function textOf(message: ChatMessage): string {
    if (typeof message.content === 'string') { return message.content; }
    return message.content.map(part => part.type === 'text' ? part.text : '').join('\n');
}

/** How one path can be written: as given, relative to the workspace, or absolute. */
function samePath(a: string, names: ReadonlySet<string>): boolean {
    return names.has(a.trim().replace(/\\/g, '/').replace(/^\.\//, ''));
}

/**
 * The 1-based line numbers of the file whose current text is already in the conversation.
 * @param names every spelling of the file's path (normalised with forward slashes, no leading ./)
 */
export function knownLines(history: readonly ChatMessage[], names: ReadonlySet<string>, fileLines: readonly string[]): Set<number> {
    const known = new Set<number>();
    for (const message of history) {
        if (message.role !== 'tool' && message.role !== 'user') { continue; }
        const text = textOf(message);
        if (!text.includes('[read_file: ') && !text.includes('[edit_file: ')) { continue; }
        HEADER_RE.lastIndex = 0;
        let header: RegExpExecArray | null;
        while ((header = HEADER_RE.exec(text)) !== null) {
            if (!samePath(header[1] ?? header[2], names)) { continue; }
            // The numbered block that belongs to this header: the next fence, before any other result
            const rest = text.slice(header.index + header[0].length);
            const nextResult = rest.search(/\n---\n|\[(?:read_file|edit_file|write_file|run_terminal|search_files|search_code)[:\]]/);
            const open = rest.indexOf('```\n');
            if (open < 0 || (nextResult >= 0 && nextResult < open)) { continue; }
            const close = rest.indexOf('\n```', open + 4);
            const block = rest.slice(open + 4, close < 0 ? undefined : close);
            for (const line of block.split('\n')) {
                const numbered = /^(\d+)\t(.*)$/s.exec(line);
                if (!numbered) { continue; }
                const n = Number(numbered[1]);
                if (fileLines[n - 1] === numbered[2]) { known.add(n); }
            }
        }
    }
    return known;
}

/** True when the model was already told these exact lines were not repeated: it is asking again, so it gets them. */
export function alreadyDeclined(history: readonly ChatMessage[], names: ReadonlySet<string>, from: number, to: number): boolean {
    const marker = new RegExp(`\\[read_file: ([^\\n\\]]+?) lines ${from}\\u2013${to} of \\d+\\] ${NOT_REPEATED}`, 'g');
    return history.some(message => {
        if (message.role !== 'tool' && message.role !== 'user') { return false; }
        marker.lastIndex = 0;
        let found: RegExpExecArray | null;
        const text = textOf(message);
        while ((found = marker.exec(text)) !== null) { if (samePath(found[1], names)) { return true; } }
        return false;
    });
}

export interface ReadPart { from: number; to: number; known: boolean }

/** The requested window as runs of new lines and of known lines long enough to leave out. */
export function splitWindow(from: number, to: number, known: ReadonlySet<number>): ReadPart[] {
    const parts: ReadPart[] = [];
    for (let line = from; line <= to; line++) {
        const isKnown = known.has(line);
        const last = parts[parts.length - 1];
        if (last && last.known === isKnown) { last.to = line; } else { parts.push({ from: line, to: line, known: isKnown }); }
    }
    // A short known run between new lines is sent with them
    const merged: ReadPart[] = [];
    for (const part of parts) {
        const keep = part.known && part.to - part.from + 1 < MIN_OMITTED_RUN ? { ...part, known: false } : part;
        const last = merged[merged.length - 1];
        if (last && last.known === keep.known) { last.to = keep.to; } else { merged.push({ ...keep }); }
    }
    return merged;
}

const ranges = (parts: ReadPart[]) => parts.map(part => part.from === part.to ? String(part.from) : `${part.from}–${part.to}`).join(', ');

/** What a read that would repeat everything returns instead of the text. */
export function notRepeatedText(filepath: string, from: number, to: number, total: number): string {
    return `[read_file: ${filepath} lines ${from}–${to} of ${total}] ${NOT_REPEATED}: these lines are already in this conversation (an earlier read or edit result) and the file has not changed since. ` +
        'Use that text. Ask for other lines if you need them; asking for exactly these lines again returns them.';
}

/** The body of a read that leaves out long runs of known lines, numbered like any read. */
export function partialBody(parts: ReadPart[], fileLines: readonly string[]): { text: string; omitted: string } {
    const out: string[] = [];
    for (const part of parts) {
        if (part.known) { out.push(`… lines ${part.from}–${part.to} not repeated: already shown above, unchanged …`); continue; }
        for (let line = part.from; line <= part.to; line++) { out.push(`${line}\t${fileLines[line - 1]}`); }
    }
    return { text: out.join('\n'), omitted: ranges(parts.filter(part => part.known)) };
}
