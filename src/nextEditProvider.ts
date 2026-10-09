/**
 * Next Edit Suggestions (NES)
 *
 * After the user makes changes, analyse the edit sequence and surrounding context
 * to predict where/what the *next* edit will be, then surface it as ghost text.
 *
 * Key improvements over the naive approach:
 *  - Pre-change snapshots capture deleted text (what was removed before insertion)
 *  - Full edit history (up to 10 changes) builds a richer pattern for the model
 *  - Edit-sequence prompt shows removed→inserted pairs so the model sees the pattern
 *  - 400 ms debounce (was 800 ms) for faster suggestions
 *  - 3000/800 char prefix/suffix context (was 1500/600)
 */

import * as vscode from 'vscode';
import { notifyUnsupportedModelOnce, unsupportedEditorModel } from './editorModel';
import * as https from 'https';
import { ignoreRules } from './ignoreRules';

// ── Edit history ──────────────────────────────────────────────────────────────

interface EditRecord {
    uri: string;
    version: number;
    /** Text that was deleted (from the pre-change snapshot). */
    removed: string;
    /** Text that was inserted. */
    inserted: string;
    /** Range affected in the post-change document. */
    range: vscode.Range;
    timestamp: number;
}

/** Full text of each document as of the last processed change event. */
const _docSnapshots = new Map<string, string>();
/** Keyed by document URI. Keeps the last MAX_HISTORY edits per file. */
const _editHistory  = new Map<string, EditRecord[]>();

const MAX_HISTORY     = 10;   // was 5
const EDIT_MAX_AGE_MS = 45_000;

export function registerNextEditTracker(context: vscode.ExtensionContext): void {
    // Seed snapshots for documents that are already open so the very first
    // change event on each file has a real pre-change baseline, not ''.
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === 'file') {
            _docSnapshots.set(doc.uri.toString(), doc.getText());
        }
    }

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((doc) => {
            if (doc.uri.scheme === 'file') {
                _docSnapshots.set(doc.uri.toString(), doc.getText());
            }
        }),
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.uri.scheme !== 'file') { return; }
            const key      = e.document.uri.toString();
            const snapshot = _docSnapshots.get(key) ?? '';   // text BEFORE this change
            const records  = _editHistory.get(key) ?? [];

            for (const change of e.contentChanges) {
                // Extract deleted text from the pre-change snapshot using the byte offset
                const removed = snapshot.length > 0 && change.rangeLength > 0
                    ? snapshot.substring(change.rangeOffset, change.rangeOffset + change.rangeLength)
                    : '';

                records.push({
                    uri:       key,
                    version:   e.document.version,
                    removed,
                    inserted:  change.text,
                    range:     change.range,
                    timestamp: Date.now(),
                });
                if (records.length > MAX_HISTORY) { records.shift(); }
            }

            _editHistory.set(key, records);
            // Save the post-change text as the "before" snapshot for the next event
            _docSnapshots.set(key, e.document.getText());
        })
    );
}

/** Returns fresh edits for the given document (filters out stale entries). */
function _freshEdits(uri: string): EditRecord[] {
    const records = _editHistory.get(uri);
    if (!records || records.length === 0) { return []; }
    const cutoff = Date.now() - EDIT_MAX_AGE_MS;
    return records.filter(r => r.timestamp >= cutoff);
}

// ── NES prompt ────────────────────────────────────────────────────────────────

/**
 * Build a compact edit-sequence summary.
 * Shows up to 5 of the most recent edits as "deleted → inserted" pairs so the
 * model can identify the transformation pattern the developer is applying.
 */
function _buildEditSummary(edits: EditRecord[]): string {
    return edits.slice(-5).map((e, i) => {
        const del = e.removed
            ? `\`${e.removed.slice(0, 60)}${e.removed.length > 60 ? '…' : ''}\``
            : '(nothing)';
        const ins = e.inserted
            ? `\`${e.inserted.slice(0, 60)}${e.inserted.length > 60 ? '…' : ''}\``
            : '(nothing)';
        return `${i + 1}. removed ${del} → inserted ${ins}`;
    }).join('\n');
}

async function fetchNextEdit(
    apiKey: string,
    model: string,
    language: string,
    editSummary: string,
    surroundingCode: string,
    signal: AbortSignal
): Promise<string> {
    const systemMsg =
        'You are a code editor AI that predicts a developer\'s next edit based on their recent change pattern.\n' +
        'Study the sequence of edits to identify the transformation being applied, ' +
        'then output ONLY the text that should be inserted at <CURSOR>.\n' +
        'If no edit is needed at the cursor, output an empty string.\n' +
        'Never add explanation, markdown fences, or surrounding code.';

    const userMsg =
        `Language: ${language}\n\n` +
        `Recent edit sequence (oldest → newest):\n${editSummary}\n\n` +
        `Apply the same pattern at <CURSOR> in the code below:\n\n${surroundingCode}`;

    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemMsg },
                { role: 'user',   content: userMsg   },
            ],
            max_tokens: 200,   // was 120
            temperature: 0.05,
        });

        const req = https.request(
            {
                hostname: 'openrouter.ai',
                path: '/api/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'vscode-codico',
                    'X-Title': 'Codico',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = '';
                res.setEncoding('utf8'); // keeps characters split across chunks intact
                res.on('data', (c: string) => { data += c.toString(); });
                res.on('end', () => {
                    try {
                        const text: string = JSON.parse(data)?.choices?.[0]?.message?.content ?? '';
                        resolve(text.trim());
                    } catch { resolve(''); }
                });
            }
        );
        req.on('error', reject);
        signal.addEventListener('abort', () => req.destroy(), { once: true });
        req.write(body);
        req.end();
    });
}

// ── Provider ──────────────────────────────────────────────────────────────────

let _nesDebounce: ReturnType<typeof setTimeout> | undefined;
/** The request waiting on the debounce timer; a newer one settles it (else it never resolves). */
let _nesDebounceResolve: ((value: null) => void) | undefined;

export class NextEditProvider implements vscode.InlineCompletionItemProvider {
    constructor(private readonly _context: vscode.ExtensionContext) {}

    provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _ctx: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionList | null> {
        const config = vscode.workspace.getConfiguration('codico');
        if (!config.get<boolean>('nextEditSuggestionsEnabled', true)) {
            return Promise.resolve(null);
        }

        // Respect .copilotignore
        if (document.uri.scheme === 'file') {
            const rel = vscode.workspace.asRelativePath(document.uri);
            if (ignoreRules.shouldIgnore(rel)) { return Promise.resolve(null); }
        }

        const edits = _freshEdits(document.uri.toString());
        // Need at least 2 edits to detect a meaningful pattern
        if (edits.length < 2) { return Promise.resolve(null); }

        const lastEdit = edits[edits.length - 1];

        // Activate only when the cursor is near the last edited line but not too far away.
        // dist === 0 is intentionally allowed: after a deletion the cursor lands at the
        // deleted-line position (same line as lastEdit.range.start), and NES should still
        // trigger. The 2-edit requirement and debounce below prevent noise during active typing.
        const dist = Math.abs(position.line - lastEdit.range.start.line);
        if (dist > 20) { return Promise.resolve(null); }

        return new Promise((resolve) => {
            if (_nesDebounce) { clearTimeout(_nesDebounce); }
            _nesDebounceResolve?.(null);
            _nesDebounceResolve = resolve;

            _nesDebounce = setTimeout(async () => {
                _nesDebounceResolve = undefined;
                if (token.isCancellationRequested) { return resolve(null); }

                const apiKey = await this._context.secrets.get('openRouterApiKey');
                if (!apiKey) { return resolve(null); }

                const model = config.get<string>('model', 'deepseek/deepseek-v4-flash');
                if (unsupportedEditorModel(model)) { notifyUnsupportedModelOnce('Next-edit suggestions', model); return resolve(null); }

                // Wider context: 3000 prefix + 800 suffix (was 1500 + 600)
                const offset      = document.offsetAt(position);
                const prefixStart = document.positionAt(Math.max(0, offset - 3000));
                const suffixEnd   = document.positionAt(Math.min(document.getText().length, offset + 800));

                const prefix      = document.getText(new vscode.Range(prefixStart, position));
                const suffix      = document.getText(new vscode.Range(position, suffixEnd));
                const surrounding = `${prefix}<CURSOR>${suffix}`;
                const editSummary = _buildEditSummary(edits);

                const abort = new AbortController();
                token.onCancellationRequested(() => abort.abort());

                try {
                    const suggestion = await fetchNextEdit(
                        apiKey, model,
                        document.languageId,
                        editSummary,
                        surrounding,
                        abort.signal
                    );
                    if (!suggestion || token.isCancellationRequested) { return resolve(null); }

                    resolve({
                        items: [
                            new vscode.InlineCompletionItem(
                                suggestion,
                                new vscode.Range(position, position)
                            ),
                        ],
                    });
                } catch { resolve(null); }
            }, 400);  // was 800 ms
        });
    }
}
