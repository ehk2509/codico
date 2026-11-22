/**
 * Streaming, line-based Markdown renderer for the terminal. Text arrives in arbitrary chunks; each
 * completed line is rendered immediately so answers appear live. Tool calls the model writes as text
 * (fenced ```tool blocks or Qwen-style XML) are hidden, since Codico shows them as tool events instead.
 */
import { Paint, displayWidth, sanitize, SYMBOLS } from './ansi';

const KEYWORDS = new Set(('abstract as async await break case catch class const continue def default del do elif else enum ' +
    'export extends false finally fn for from func function go if impl implements import in instanceof interface let ' +
    'match mod mut new nil none null package pass private protected pub public raise readonly return self static ' +
    'struct super switch this throw throws true try type typeof undefined use var void while with yield').split(' '));

/** Small, language-agnostic highlighter: comments, strings, numbers and common keywords. */
export function highlightCode(line: string, paint: Paint): string {
    if (!paint.enabled) { return line; }
    const comment = /^(\s*)(\/\/.*|#(?![!\[]).*|--\s.*)$/.exec(line);
    if (comment) { return comment[1] + paint.gray(comment[2]); }
    return line.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/.*$)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)\b/g,
        (match, str: string, trailing: string, num: string, word: string) => {
            if (str) { return paint.green(str); }
            if (trailing) { return paint.gray(trailing); }
            if (num) { return paint.yellow(num); }
            if (word && KEYWORDS.has(word)) { return paint.magenta(word); }
            return match;
        });
}

export function renderInline(text: string, paint: Paint): string {
    if (!paint.enabled) { return text.replace(/\*\*([^*]+)\*\*|__([^_\s][^_]*)__/g, (_, a?: string, b?: string) => a ?? b ?? ''); }
    const codeSpans: string[] = [];
    let out = text.replace(/`([^`]+)`/g, (_, code: string) => { codeSpans.push(paint.cyan(code)); return `\u0000${codeSpans.length - 1}\u0000`; });
    out = out
        .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a?: string, b?: string) => paint.bold(a ?? b ?? ''))
        .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,:;!?]|$)/g, (_, pre: string, body: string) => pre + paint.italic(body))
        .replace(/~~([^~]+)~~/g, (_, body: string) => paint.dim(body))
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => paint.underline(label) + paint.gray(` (${url})`));
    // eslint-disable-next-line no-control-regex
    return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codeSpans[Number(i)]);
}

/** Wrap plain words to a width, keeping a hanging indent for continuation lines. */
export function wrap(text: string, width: number, indent = ''): string[] {
    if (width < 20 || displayWidth(text) <= width) { return [text]; }
    const words = text.split(/(\s+)/);
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
        if (current && displayWidth(current + word) > width && word.trim()) {
            lines.push(current.trimEnd());
            current = indent + word;
        } else { current += word; }
    }
    if (current.trim()) { lines.push(current.trimEnd()); }
    return lines;
}

export class MarkdownStream {
    private pending = '';
    private code: { lang: string } | undefined;
    private hidden: { close: RegExp } | undefined;
    private blankRun = 0;
    /** Rendered something visible since construction (or the last reset). */
    wrote = false;
    /** The last line written was blank. */
    get endsBlank(): boolean { return this.blankRun > 0; }

    constructor(private readonly paint: Paint, private readonly width: () => number,
        private readonly write: (text: string) => void, private readonly toolNames: ReadonlySet<string> = new Set()) { }

    push(delta: string): void {
        this.pending += delta.replace(/\r\n/g, '\n');
        let newline: number;
        while ((newline = this.pending.indexOf('\n')) >= 0) {
            const line = this.pending.slice(0, newline);
            this.pending = this.pending.slice(newline + 1);
            this.line(line);
        }
    }

    /** Render a trailing partial line and close any open block. */
    end(): void {
        if (this.pending) { this.line(this.pending); this.pending = ''; }
        if (this.code) { this.emit(this.paint.gray('  ╰─')); this.code = undefined; }
        this.hidden = undefined;
    }

    private emit(rendered: string): void {
        if (!rendered.trim()) {
            if (!this.wrote || this.blankRun > 0) { return; } // collapse leading and repeated blank lines
            this.blankRun++;
        } else { this.blankRun = 0; }
        this.wrote = true;
        this.write(rendered + '\n');
    }

    private line(raw: string): void {
        const line = sanitize(raw);
        const p = this.paint;
        if (this.hidden) {
            if (this.hidden.close.test(line)) { this.hidden = undefined; }
            return;
        }
        const fence = /^\s*(```+|~~~+)\s*([\w.+#-]*)\s*$/.exec(line);
        if (this.code) {
            if (fence) { this.emit(p.gray('  ╰─')); this.code = undefined; return; }
            this.emit(p.gray('  ' + SYMBOLS.bar + ' ') + highlightCode(line, p));
            return;
        }
        if (fence) {
            const lang = fence[2];
            if (lang && this.toolNames.has(lang)) { this.hidden = { close: /^\s*(```+|~~~+)\s*$/ }; return; }
            this.code = { lang };
            this.emit(p.gray('  ╭─' + (lang ? ' ' + lang + ' ' : '')));
            return;
        }
        if (/^\s*<tool_call>/.test(line)) {
            this.hidden = { close: /<\/tool_call>/ };
            if (this.hidden.close.test(line)) { this.hidden = undefined; }
            return;
        }
        if (/^\s*<function=[\w.-]+>/.test(line)) {
            this.hidden = { close: /<\/function>/ };
            if (this.hidden.close.test(line)) { this.hidden = undefined; }
            return;
        }
        const width = this.width() - 2;
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            const text = renderInline(heading[2].replace(/\s+#+\s*$/, ''), p);
            if (this.wrote) { this.emit(''); }
            this.emit(heading[1].length <= 2 ? p.bold(p.accent(text)) : p.bold(text));
            return;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { this.emit(p.gray('─'.repeat(Math.min(width, 60)))); return; }
        const quote = /^\s*>\s?(.*)$/.exec(line);
        if (quote) {
            for (const part of wrap(renderInline(quote[1], p), width - 2)) { this.emit(p.gray(SYMBOLS.bar + ' ') + p.italic(part)); }
            return;
        }
        const item = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
        if (item) {
            const depth = Math.floor(item[1].replace(/\t/g, '  ').length / 2);
            const pad = '  '.repeat(depth);
            const bullet = item[3] !== undefined
                ? (item[3] === ' ' ? p.gray('☐') : p.green('☑'))
                : /\d/.test(item[2]) ? p.accent(item[2]) : p.accent('•');
            const lead = pad + bullet + ' ';
            const hang = pad + ' '.repeat(displayWidth(bullet) + 1);
            wrap(renderInline(item[4], p), width - displayWidth(lead), '').forEach((part, i) => this.emit((i ? hang : lead) + part));
            return;
        }
        if (/^\s*\|.*\|\s*$/.test(line)) {
            if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) { this.emit(p.gray(line.replace(/[^|]/g, '─').replace(/\|/g, '┼'))); return; }
            this.emit(line.split('|').map(cell => renderInline(cell, p)).join(p.gray('│')));
            return;
        }
        for (const part of wrap(renderInline(line, p), width)) { this.emit(part); }
    }
}
