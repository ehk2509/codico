import { buildImportUsageAudit } from './importUsageAudit';
const LIFECYCLE_RE = /\b(?:done|finish(?:ed|reason)?|complete(?:d|ion)?|terminal|end(?:ed)?|error|abort(?:ed)?|close(?:d)?|success|resolve|reject|stop)\b/i;
const STATE_RE = /\b(?:let|const|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:true|false|null|undefined)\b|(?:===|!==)\s*(?:true|false|null|undefined)/i;
const SEMANTIC_TERMINAL_RE = /(?:\[DONE\]|\b(?:done|finish(?:ed|reason)?|complete(?:d|ion)?|terminal|success|resolve|stop)\b|finish_reason)/i;
const TRANSPORT_TERMINAL_RE = /(?:\.on\(\s*['"](?:end|close|error|aborted?)['"]|\b(?:connection|socket|transport|end(?:ed)?|close(?:d)?|error|abort(?:ed)?|reject)\b)/i;

interface AuditCandidate {
    line: number;
    text: string;
}

function renderCandidates(title: string, items: AuditCandidate[]): string {
    if (items.length === 0) { return ''; }
    return title + '\n' + items.map(item => `- L${item.line}: ${item.text}`).join('\n') + '\n';
}

/**
 * Deterministically surfaces nearby lifecycle branches after a stateful edit.
 * This is source-derived evidence only: no model summary and no hidden tests.
 *
 * The audit distinguishes semantic completion from transport termination so a
 * new "premature closure" guard cannot accidentally treat one success encoding
 * (for example an explicit sentinel) as the only valid terminal path.
 */
export function buildLocalInvariantAudit(source: string, changedText: string): string {
    const importAudit = buildImportUsageAudit(source);
    if (!LIFECYCLE_RE.test(changedText) && !STATE_RE.test(changedText)) { return importAudit; }

    const lines = source.split('\n');
    const index = source.indexOf(changedText);
    const editLine = index >= 0 ? source.slice(0, index).split('\n').length - 1 : 0;
    const from = Math.max(0, editLine - 90);
    const to = Math.min(lines.length, editLine + changedText.split('\n').length + 90);

    const candidates: AuditCandidate[] = [];
    for (let i = from; i < to; i++) {
        const text = lines[i].trim();
        if (!text || !LIFECYCLE_RE.test(text)) { continue; }
        candidates.push({
            line: i + 1,
            text: text.length > 180 ? text.slice(0, 179) + '…' : text,
        });
        if (candidates.length >= 18) { break; }
    }
    if (candidates.length === 0) { return importAudit; }

    const semantic = candidates.filter(item => SEMANTIC_TERMINAL_RE.test(item.text)).slice(0, 10);
    const transport = candidates.filter(item => TRANSPORT_TERMINAL_RE.test(item.text)).slice(0, 10);

    return '\n\n[Local invariant audit]\n' +
        'This edit changes lifecycle/state logic. Review source-derived terminal paths in the edited file before broadening:\n' +
        renderCandidates('Semantic completion / normal terminal candidates:', semantic) +
        renderCandidates('Transport closure / failure candidates:', transport) +
        'Proof obligation:\n' +
        '- Define exactly what each new flag/guard means.\n' +
        '- If a new guard reports premature transport end, every semantic completion/normal-terminal candidate above must transition or bypass that guard before transport closure.\n' +
        '- Do not assume one terminal representation is the only success path: an explicit sentinel and a provider finish/completion field can both represent normal completion when the surrounding source treats them as terminal.\n' +
        '- Keep resource/transport closure distinct from semantic completion when they are different states.\n' +
        '- If any listed normal path can trigger the new failure guard, revise this same file before moving on.' + importAudit;
}
