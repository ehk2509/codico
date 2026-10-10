import { DisplayMessage, ReplayEvent } from './chatProtocol';

/**
 * A conversation as a Markdown document: what was asked, what was answered, the steps taken
 * and each reply's change report. Reasoning and raw terminal output are left out.
 */

/** A reply's text, tool steps and change report, from the events saved with it. */
function replyParts(events: ReplayEvent[]): { text: string; steps: string[]; report: string } {
    let text = '';
    const steps: string[] = [];
    let report = '';
    for (const event of events) {
        if (event.type === 'appendContent') { text += event.text ?? ''; }
        else if (event.type === 'toolStart' && typeof event.tool === 'string') {
            steps.push(`- \`${event.tool}\`${typeof event.label === 'string' && event.label ? ` ${event.label.replace(/\s+/g, ' ')}` : ''}`);
        } else if (event.type === 'patchPassport' && typeof event.markdown === 'string') { report = event.markdown; }
        else if (event.type === 'streamError' && typeof event.message === 'string') { text += `\n\n> Error: ${event.message}\n`; }
    }
    return { text: text.trim(), steps, report };
}

/** Headings of an embedded document, moved down so they sit under the message's own heading. */
function demoteHeadings(markdown: string, levels: number): string {
    let fenced = false;
    return markdown.split('\n').map(line => {
        if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line; }
        return !fenced && /^#{1,6}\s/.test(line) ? '#'.repeat(levels) + line : line;
    }).join('\n');
}

const stamp = (ms: number | undefined): string => ms ? ` — ${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';

export function threadMarkdown(name: string, messages: DisplayMessage[]): string {
    const out: string[] = [`# ${name.replace(/\s+/g, ' ').trim() || 'Conversation'}`, ''];
    for (const message of messages) {
        if (message.role === 'user') {
            out.push(`## You${stamp(message.at)}`, '', message.text.trim(), '');
            continue;
        }
        out.push(`## Codico${stamp(message.at)}`, '');
        if (!message.events?.length) {
            // Saved before replies were recorded in full: only a summary was kept
            out.push(message.text.trim(), '');
            continue;
        }
        const { text, steps, report } = replyParts(message.events);
        if (steps.length > 0) {
            out.push(`<details><summary>${steps.length} step${steps.length === 1 ? '' : 's'}</summary>`, '', ...steps, '', '</details>', '');
        }
        // Headings inside the reply stay below "## Codico"
        if (text) { out.push(demoteHeadings(text, 2), ''); }
        if (report) { out.push(demoteHeadings(report.trim(), 2), ''); }
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** A file name for the export: the thread's name, safe on every platform. */
export function exportFileName(name: string): string {
    const base = name.normalize('NFKD').replace(/[^\w\s.-]/g, '').trim().replace(/\s+/g, '-').replace(/^[.-]+/, '').slice(0, 60).replace(/[.-]+$/, '');
    return `${base || 'conversation'}.md`;
}
