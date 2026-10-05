const LIFECYCLE_RE = /\b(?:done|finish(?:ed|reason)?|complete(?:d|ion)?|terminal|end(?:ed)?|error|abort(?:ed)?|close(?:d)?|success|resolve|reject|stop)\b/i;
const STATE_RE = /\b(?:let|const|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:true|false|null|undefined)\b|(?:===|!==)\s*(?:true|false|null|undefined)/i;

/**
 * Deterministically surfaces nearby lifecycle branches after a stateful edit.
 * This is source-derived evidence only: no model summary and no hidden tests.
 */
export function buildLocalInvariantAudit(source: string, changedText: string): string {
    if (!LIFECYCLE_RE.test(changedText) && !STATE_RE.test(changedText)) { return ''; }

    const lines = source.split('\n');
    const index = source.indexOf(changedText);
    const editLine = index >= 0 ? source.slice(0, index).split('\n').length - 1 : 0;
    const from = Math.max(0, editLine - 90);
    const to = Math.min(lines.length, editLine + changedText.split('\n').length + 90);

    const candidates: Array<{ line: number; text: string }> = [];
    for (let i = from; i < to; i++) {
        const text = lines[i].trim();
        if (!text || !LIFECYCLE_RE.test(text)) { continue; }
        candidates.push({ line: i + 1, text: text.length > 180 ? text.slice(0, 179) + '…' : text });
        if (candidates.length >= 14) { break; }
    }
    if (candidates.length === 0) { return ''; }

    return '\n\n[Local invariant audit]\n' +
        'This edit changes lifecycle/state logic. Review these nearby existing paths in the edited file before broadening:\n' +
        candidates.map(item => `- L${item.line}: ${item.text}`).join('\n') +
        '\nChecklist:\n' +
        '- Define exactly what each new flag/guard means.\n' +
        '- Update or bypass it consistently for every normal success/completion/terminal/cancellation path.\n' +
        '- Keep resource/transport closure distinct from semantic completion when they are different states.\n' +
        '- If any listed normal path can trigger the new failure guard, revise this same file before moving on.';
}
