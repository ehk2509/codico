/** Renders standalone agent events as a modern terminal transcript. */
import type { StandaloneEvent } from '../agent';
import { Paint, SYMBOLS, sanitize, truncate, terminalWidth } from './ansi';
import { MarkdownStream } from './markdown';

interface Out { write(text: string): unknown; isTTY?: boolean; columns?: number }

export class Spinner {
    private timer: NodeJS.Timeout | undefined;
    private frame = 0;
    private started = 0;
    private label = '';
    detail = '';

    constructor(private readonly out: Out, private readonly paint: Paint) { }

    get active(): boolean { return !!this.timer; }

    start(label: string): void {
        this.label = label;
        if (!this.out.isTTY) { return; }
        if (!this.timer) {
            this.started = Date.now();
            this.out.write('\x1b[?25l');
            this.timer = setInterval(() => this.draw(), 80);
            this.timer.unref?.();
        }
        this.draw();
    }

    setLabel(label: string): void { this.label = label; }

    private draw(): void {
        const p = this.paint;
        const frames = SYMBOLS.spinner;
        const glyph = p.accent(frames[this.frame++ % frames.length]);
        const seconds = ((Date.now() - this.started) / 1000).toFixed(1) + 's';
        const meta = p.gray(`(${seconds}${this.detail ? ' · ' + this.detail : ''} · ctrl+c to interrupt)`);
        this.out.write('\r\x1b[2K' + truncate(`${glyph} ${p.bold(this.label)}… ${meta}`, terminalWidth(this.out) + 40));
    }

    stop(): void {
        if (!this.timer) { return; }
        clearInterval(this.timer);
        this.timer = undefined;
        this.out.write('\r\x1b[2K\x1b[?25h');
    }
}

const TOOL_LABELS: Record<string, string> = {
    read_file: 'Read', list_directory: 'List', find_files: 'Find', search_files: 'Search', search_code: 'Search code',
    write_file: 'Write', edit_file: 'Update', run_terminal: 'Bash', get_diagnostics: 'Diagnostics', lsp_symbol: 'Symbols',
    remember: 'Remember', delegate: 'Task', fetch_url: 'Fetch', web_search: 'Web search', mcp_call: 'MCP',
    browser_navigate: 'Browser', browser_click: 'Click', browser_type: 'Type', browser_get_text: 'Page text',
    browser_screenshot: 'Screenshot', browser_close: 'Close browser',
};

export function toolLabel(tool: string): string {
    return TOOL_LABELS[tool] ?? tool.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

/** One-line human summary of a tool result. */
export function summarizeResult(tool: string, text: string, ok: boolean): { summary: string; preview: string[] } {
    const clean = sanitize(text);
    const lines = clean.split('\n');
    if (!ok) {
        if (tool === 'run_terminal' || tool === 'get_diagnostics') {
            const code = /^Exit code: (\S+)/.exec(clean)?.[1];
            const body = lines.filter(l => l.trim() && !/^Exit code:/.test(l));
            return { summary: code ? `Exited with code ${code}` : lines[0], preview: body.slice(-6) };
        }
        return { summary: lines[0].slice(0, 300), preview: [] };
    }
    switch (tool) {
        case 'read_file': {
            const m = /lines (\d+)-(\d+) of (\d+)/.exec(lines[0]);
            return { summary: m ? `Read ${Number(m[2]) - Number(m[1]) + 1} lines` + (m[3] !== m[2] || m[1] !== '1' ? ` (${m[1]}-${m[2]} of ${m[3]})` : '') : 'Read file', preview: [] };
        }
        case 'list_directory': case 'find_files': {
            const n = lines.filter(l => l.trim()).length;
            return { summary: `${n} ${tool === 'find_files' ? 'match' + (n === 1 ? '' : 'es') : 'entr' + (n === 1 ? 'y' : 'ies')}`, preview: [] };
        }
        case 'search_files': case 'search_code': {
            const hits = lines.filter(l => /:\d+[:\s]/.test(l)).length;
            return { summary: hits ? `${hits} result${hits === 1 ? '' : 's'}` : truncate(lines[0], 120), preview: [] };
        }
        case 'run_terminal': case 'get_diagnostics': {
            const body = lines.filter(l => l.trim() && !/^Exit code:/.test(l));
            return { summary: body.length ? `${body.length} line${body.length === 1 ? '' : 's'} of output` : 'Completed with no output', preview: body.slice(-4) };
        }
        default:
            return { summary: truncate(lines.find(l => l.trim()) ?? 'Done', 160), preview: [] };
    }
}

/** Color a unified-style diff produced by computeLineDiff (and tolerate plain text). */
export function colorDiff(text: string, paint: Paint, maxLines = 60): string {
    const lines = sanitize(text).split('\n');
    const shown = lines.slice(0, maxLines).map(line => {
        if (line.startsWith('@@')) { return paint.cyan(line); }
        if (line.startsWith('+')) { return paint.green(line); }
        if (line.startsWith('-')) { return paint.red(line); }
        return paint.gray(line);
    });
    if (lines.length > maxLines) { shown.push(paint.gray(`… ${lines.length - maxLines} more lines`)); }
    return shown.map(l => '    ' + l).join('\n');
}

export interface TurnStats { tools: number; failed: number; promptTokens: number; completionTokens: number; started: number }

export function formatTokens(n: number): string {
    return n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

export class TranscriptRenderer {
    readonly spinner: Spinner;
    private markdown: MarkdownStream | undefined;
    private streamed = false;
    turn: TurnStats = { tools: 0, failed: 0, promptTokens: 0, completionTokens: 0, started: Date.now() };
    readonly totals = { promptTokens: 0, completionTokens: 0, turns: 0 };

    constructor(private readonly out: Out, private readonly err: Out, private readonly paint: Paint,
        private readonly toolNames: ReadonlySet<string>, public verbose = false) {
        this.spinner = new Spinner(err, paint);
    }

    beginTurn(): void {
        this.turn = { tools: 0, failed: 0, promptTokens: 0, completionTokens: 0, started: Date.now() };
        this.streamed = false;
        this.spinner.detail = '';
        this.spinner.start('Thinking');
    }

    private stream(): MarkdownStream {
        if (!this.markdown) {
            this.markdown = new MarkdownStream(this.paint, () => terminalWidth(this.out), text => this.out.write(text), this.toolNames);
        }
        return this.markdown;
    }

    private closeStream(): void {
        if (this.markdown) {
            this.markdown.end();
            if (this.markdown.wrote && !this.markdown.endsBlank) { this.out.write('\n'); }
            this.markdown = undefined;
        }
    }

    handle(event: StandaloneEvent): void {
        const p = this.paint;
        switch (event.type) {
            case 'thinking':
                this.spinner.setLabel(event.text === 'Compacting' ? 'Compacting the conversation' : 'Thinking');
                break;
            case 'compacted': {
                const active = this.spinner.active;
                this.spinner.stop();
                this.closeStream();
                const color = event.ok === false ? p.yellow : p.gray;
                this.err.write(`  ${p.gray(SYMBOLS.branch)}  ${color(sanitize(event.text ?? 'Compacted the conversation'))}\n`);
                if (active) { this.spinner.start('Thinking'); }
                break;
            }
            case 'delta': {
                if (!event.text) { break; }
                this.spinner.stop();
                if (!this.markdown) { this.out.write('\n'); }
                this.stream().push(event.text);
                this.streamed = true;
                break;
            }
            case 'text': {
                this.spinner.stop();
                if (!this.streamed && event.text) {
                    this.out.write('\n');
                    this.stream().push(event.text);
                }
                this.closeStream();
                this.streamed = false;
                break;
            }
            case 'toolStart': {
                this.spinner.stop();
                this.closeStream();
                this.streamed = false;
                this.turn.tools++;
                const arg = sanitize(event.text ?? '').replace(/\s+/g, ' ').trim();
                const label = p.bold(toolLabel(event.tool ?? 'tool'));
                const width = terminalWidth(this.err);
                this.err.write(`${p.accent(SYMBOLS.dot)} ${label}${arg ? p.gray('(') + truncate(arg, width - 20) + p.gray(')') : ''}\n`);
                this.spinner.start(event.tool === 'run_terminal' ? 'Running' : event.tool === 'delegate' ? 'Delegating' : 'Working');
                break;
            }
            case 'toolResult': {
                this.spinner.stop();
                const ok = event.ok !== false;
                if (!ok) { this.turn.failed++; }
                const { summary, preview } = summarizeResult(event.tool ?? '', event.text ?? '', ok);
                const denied = /^Denied:/.test(event.text ?? '');
                const color = ok ? p.gray : denied ? p.yellow : p.red;
                this.err.write(`  ${p.gray(SYMBOLS.branch)}  ${color(truncate(summary, terminalWidth(this.err) - 8))}\n`);
                const extra = this.verbose ? sanitize(event.text ?? '').split('\n').slice(0, 40) : preview;
                for (const line of extra) { this.err.write('     ' + p.gray(truncate(line, terminalWidth(this.err) - 8)) + '\n'); }
                this.spinner.start('Thinking');
                break;
            }
            case 'usage':
                this.turn.promptTokens += event.promptTokens ?? 0;
                this.turn.completionTokens += event.completionTokens ?? 0;
                this.spinner.detail = `${SYMBOLS.arrow} ${formatTokens(this.turn.promptTokens + this.turn.completionTokens)} tokens`;
                break;
        }
    }

    endTurn(outcome: 'done' | 'stopped' | 'failed', message?: string, hint?: string): void {
        this.spinner.stop();
        this.closeStream();
        this.totals.promptTokens += this.turn.promptTokens;
        this.totals.completionTokens += this.turn.completionTokens;
        this.totals.turns++;
        const p = this.paint;
        const seconds = ((Date.now() - this.turn.started) / 1000).toFixed(1);
        const parts = [`${seconds}s`];
        if (this.turn.tools) { parts.push(`${this.turn.tools} tool${this.turn.tools === 1 ? '' : 's'}${this.turn.failed ? ` (${this.turn.failed} failed)` : ''}`); }
        if (this.turn.promptTokens || this.turn.completionTokens) {
            parts.push(`${formatTokens(this.turn.promptTokens)} in · ${formatTokens(this.turn.completionTokens)} out`);
        }
        if (outcome === 'failed' && message) {
            this.err.write(`\n${p.red(SYMBOLS.cross)} ${p.bold(sanitize(message))}\n`);
            if (hint) { this.err.write(`  ${p.gray(sanitize(hint))}\n`); }
            if (this.turn.tools || this.turn.promptTokens) { this.err.write(p.gray(`  ${parts.join(' · ')}`) + '\n'); }
            return;
        }
        const head = outcome === 'done' ? p.green(SYMBOLS.check + ' Done') : outcome === 'stopped' ? p.yellow('■ Interrupted') : p.red(SYMBOLS.cross + ' Failed');
        this.err.write(`${head} ${p.gray('· ' + parts.join(' · '))}\n`);
    }
}
