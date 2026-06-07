import * as vscode from 'vscode';
import * as https from 'https';
import { StringDecoder } from 'string_decoder';

// ── Slash commands available in the inline chat picker ─────────────────────
interface SlashCommand {
    label: string;
    detail: string;
    instruction: string;
    /** 'inline' streams a diff into the editor; 'chat' routes to the sidebar. */
    route: 'inline' | 'chat';
}

const SLASH_COMMANDS: SlashCommand[] = [
    {
        label: '$(wrench) /fix',
        detail: 'Fix bugs, errors, and issues in the selected code',
        instruction:
            'Fix all bugs, errors, and issues in this code. ' +
            'Preserve the original logic and structure where it is correct. ' +
            'Only change what needs to be fixed.',
        route: 'inline',
    },
    {
        label: '$(book) /doc',
        detail: 'Add JSDoc comments and inline documentation',
        instruction:
            'Add clear JSDoc comments to all functions, classes, and exported members. ' +
            'Add concise inline comments where the logic is non-obvious. ' +
            'Do not change any logic — only add comments.',
        route: 'inline',
    },
    {
        label: '$(comment-discussion) /explain',
        detail: 'Explain what this code does (opens in chat)',
        instruction:
            'Explain this code clearly. Describe what it does, how it works, ' +
            'its inputs and outputs, any side effects, and any notable patterns or concerns.',
        route: 'chat',
    },
    {
        label: '$(beaker) /tests',
        detail: 'Generate unit tests (opens in chat)',
        instruction:
            'Write comprehensive unit tests for this code. ' +
            'Cover the main functionality, edge cases, and error paths. ' +
            'Use the same test framework and style as the rest of the project.',
        route: 'chat',
    },
];

// ── Decoration types ───────────────────────────────────────────────────────
let _removedDeco: vscode.TextEditorDecorationType | undefined;
let _addedDeco:   vscode.TextEditorDecorationType | undefined;
let _addedTextDeco: vscode.TextEditorDecorationType | undefined;

function _getDecos(): { removed: vscode.TextEditorDecorationType; added: vscode.TextEditorDecorationType; addedText: vscode.TextEditorDecorationType } {
    if (!_removedDeco || !_addedDeco || !_addedTextDeco) {
        throw new Error('Decoration types not initialized — call registerInlineDiffCommands first');
    }
    return { removed: _removedDeco, added: _addedDeco, addedText: _addedTextDeco };
}

// ── SSE streaming edit ─────────────────────────────────────────────────────
function streamEdit(
    apiKey: string,
    model: string,
    instruction: string,
    code: string,
    language: string,
    signal: AbortSignal,
    onToken: (delta: string) => void
): Promise<void> {
    return new Promise((resolve, reject) => {
        const systemMsg =
            'You are a code editing assistant. When given an instruction and a code snippet, ' +
            'return ONLY the modified code. Do NOT wrap it in markdown fences, do NOT add ' +
            'explanation. Output the raw code exactly as it should appear in the file.';
        const userMsg = `Instruction: ${instruction}\n\nLanguage: ${language}\n\nCode:\n${code}`;

        const body = JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemMsg },
                { role: 'user',   content: userMsg },
            ],
            max_tokens: 4096,
            temperature: 0.2,
            stream: true,
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
                // Reject on HTTP-level errors — error bodies contain no SSE lines so
                // without this check the promise would resolve with an empty proposed edit.
                if (res.statusCode && res.statusCode >= 400) {
                    let errBody = '';
                    res.on('data', (d: Buffer) => { errBody += d.toString(); });
                    res.on('end', () => {
                        try {
                            const parsed = JSON.parse(errBody) as { error?: { message?: string }; message?: string };
                            const msg = parsed?.error?.message ?? parsed?.message ?? errBody.slice(0, 300);
                            reject(new Error(`HTTP ${res.statusCode}: ${msg}`));
                        } catch {
                            reject(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 300)}`));
                        }
                    });
                    res.on('error', reject);
                    return;
                }

                // StringDecoder reassembles multi-byte UTF-8 codepoints across TCP chunk
                // boundaries, preventing U+FFFD corruption in non-ASCII code.
                const decoder = new StringDecoder('utf8');
                let buf = '';

                function processSSELine(line: string): void {
                    if (!line.startsWith('data:')) { return; }
                    const raw = line.slice(5).trim();
                    if (raw === '[DONE]') { return; }
                    try {
                        const delta: string = JSON.parse(raw)?.choices?.[0]?.delta?.content ?? '';
                        if (delta) { onToken(delta); }
                    } catch { /* skip malformed frames */ }
                }

                res.on('data', (chunk: Buffer) => {
                    buf += decoder.write(chunk);
                    const lines = buf.split('\n');
                    buf = lines.pop() ?? '';
                    for (const line of lines) { processSSELine(line.trim()); }
                });
                res.on('end', () => {
                    buf += decoder.end();
                    for (const line of buf.split('\n')) { processSSELine(line.trim()); }
                    resolve();
                });
                res.on('error', reject);
            }
        );

        req.on('error', reject);
        // Guard for an already-aborted signal — Node.js does not retroactively fire
        // the 'abort' event if the signal is aborted before addEventListener is called.
        if (signal.aborted) { req.destroy(); return; }
        signal.addEventListener('abort', () => req.destroy(), { once: true });
        req.write(body);
        req.end();
    });
    }

// ── Active preview session ─────────────────────────────────────────────────
interface PreviewSession {
    editor: vscode.TextEditor;
    originalText: string;
    range: vscode.Range;
    proposed: string;
    done: boolean;
    abort: AbortController;
    disposables: vscode.Disposable[];
}

let _session: PreviewSession | null = null;

function _clearSession(): void {
    if (!_session) { return; }
    if (_removedDeco)   { _session.editor.setDecorations(_removedDeco, []); }
    if (_addedDeco)     { _session.editor.setDecorations(_addedDeco, []); }
    if (_addedTextDeco) { _session.editor.setDecorations(_addedTextDeco, []); }
    _session.abort.abort();
    for (const d of _session.disposables) { d.dispose(); }
    _session = null;
    vscode.commands.executeCommand('setContext', 'codico.inlineDiffVisible', false);
}

function stripFences(text: string): string {
    // [^\s`]* matches any language tag including hyphenated ones (c-sharp, objective-c).
    // No .trim() — that would strip intentional leading indentation from the first line.
    return text.replace(/^```[^\s`]*\r?\n/, '').replace(/\r?\n```$/, '');
}

function _applyDecorations(session: PreviewSession): void {
    const editor = session.editor;
    if (!editor) { return; }

    const { removed: removedDeco, added: addedDeco, addedText: addedTextDeco } = _getDecos();

    const cleaned = stripFences(session.proposed);
    const originalLines = session.originalText.split('\n');
    const proposedLines = cleaned.split('\n');
    const startLine = session.range.start.line;

    const removedRanges: vscode.Range[] = originalLines.map((_, i) =>
        new vscode.Range(startLine + i, 0, startLine + i, 0)
    );
    editor.setDecorations(removedDeco, removedRanges);

    const proposedPreview = proposedLines.join('\n');
    editor.setDecorations(addedDeco, [
        {
            range: new vscode.Range(startLine, 0, startLine, 0),
            hoverMessage: new vscode.MarkdownString(`**Proposed**\n\`\`\`\n${proposedPreview.slice(0, 400)}\n\`\`\``),
            renderOptions: {
                after:  { contentText: '', margin: '0' },
                before: {
                    contentText: proposedLines[0] ?? '',
                    color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
                    fontStyle: 'italic',
                    margin: '0 0 0 2em',
                },
            },
        },
    ]);

    const addedRanges: vscode.DecorationOptions[] = proposedLines.slice(1).map((ln: string, i: number) => ({
        range: new vscode.Range(startLine + i + 1, 0, startLine + i + 1, 0),
        renderOptions: {
            before: {
                contentText: ln,
                color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
                fontStyle: 'italic',
                margin: '0 0 0 2em',
            },
        },
    }));
    editor.setDecorations(addedTextDeco, addedRanges);
}

async function _accept(): Promise<void> {
    const session = _session;
    if (!session) { return; }
    const cleaned = stripFences(session.proposed);
    // Capture URI and range before _clearSession() nulls out _session and disposes
    // the editor decorations — using session.editor after the clear is a use-after-free
    // if the editor was closed in the meantime.
    const uri   = session.editor.document.uri;
    const range = session.range;
    _clearSession();
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, range, cleaned);
    await vscode.workspace.applyEdit(edit);
    vscode.window.setStatusBarMessage('Codico: edit accepted ✓', 3000);
}

function _reject(): void {
    if (!_session) { return; }
    _clearSession();
    vscode.window.setStatusBarMessage('Codico: edit discarded', 2500);
}

// ── Command registration ───────────────────────────────────────────────────

export function registerInlineDiffCommands(context: vscode.ExtensionContext): void {
    _removedDeco = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
        isWholeLine: true,
        after: { color: new vscode.ThemeColor('editorGutter.deletedBackground') },
    });
    _addedDeco = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
        isWholeLine: true,
    });
    _addedTextDeco = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    });

    context.subscriptions.push(
        _removedDeco,
        _addedDeco,
        _addedTextDeco,
        vscode.commands.registerCommand('codico.acceptInlineDiff', _accept),
        vscode.commands.registerCommand('codico.rejectInlineDiff', _reject)
    );
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * @param sendToChat  Callback to route /explain and /tests to the sidebar chat.
 *                    When omitted those commands open an info message instead.
 */
export async function handleInlineChat(
    context: vscode.ExtensionContext,
    sendToChat?: (text: string) => void
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Codico: No active editor for inline chat.');
        return;
    }

    const range = editor.selection.isEmpty
        ? new vscode.Range(
              editor.document.positionAt(0),
              editor.document.positionAt(editor.document.getText().length)
          )
        : editor.selection;

    const { start, end } = range;
    const rangeLabel = editor.selection.isEmpty
        ? 'whole file'
        : `lines ${start.line + 1}–${end.line + 1}`;
    const relPath = vscode.workspace.asRelativePath(editor.document.uri);

    // ── Command picker ─────────────────────────────────────────────────────
    interface PickItem { label: string; detail: string; instruction: string; route: 'inline' | 'chat'; isCustom?: boolean }

    const items: PickItem[] = [
        ...SLASH_COMMANDS.map(cmd => ({ label: cmd.label, detail: cmd.detail, instruction: cmd.instruction, route: cmd.route })),
        {
            label: '$(edit) Custom instruction…',
            detail: 'Type your own instruction for the selected code',
            instruction: '',
            route: 'inline' as const,
            isCustom: true,
        },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: `Codico — ${relPath}  (${rangeLabel})`,
        placeHolder: 'Select a command  ·  /fix  /doc  /explain  /tests  ·  or type to filter',
        matchOnDetail: true,
    });

    if (!picked) { return; }

    const apiKey = await context.secrets.get('openRouterApiKey');
    if (!apiKey) {
        vscode.window.showErrorMessage('Codico: No API key set. Run "Codico: Set OpenRouter API Key".');
        return;
    }

    let instruction = picked.instruction;
    let route = picked.route;

    // Custom instruction — ask in a follow-up input box
    if (picked.isCustom) {
        const custom = await vscode.window.showInputBox({
            title: `Codico — ${relPath}  (${rangeLabel})`,
            prompt: 'Describe what to do with the selected code',
            placeHolder: 'e.g. "refactor to use async/await", "add error handling", "optimise for readability"',
            ignoreFocusOut: true,
        });
        if (!custom?.trim()) { return; }
        instruction = custom.trim();
        route = 'inline';
    }

    const code = editor.document.getText(range);
    const config = vscode.workspace.getConfiguration('codico');
    const model  = config.get<string>('model', 'deepseek/deepseek-v4-flash');
    const language = editor.document.languageId;

    // ── /explain and /tests → route to sidebar chat ────────────────────────
    if (route === 'chat') {
        const prompt = `${instruction}\n\n\`\`\`${language}\n${code}\n\`\`\`\n\n*(from \`${relPath}\`, ${rangeLabel})*`;
        if (sendToChat) {
            // Open sidebar first so the user sees the response stream
            await vscode.commands.executeCommand('workbench.view.extension.codico-container');
            sendToChat(prompt);
        } else {
            vscode.window.showInformationMessage('Codico: Open the chat panel to see the result.');
        }
        return;
    }

    // ── /fix, /doc, custom → inline streaming diff ─────────────────────────
    _clearSession();

    const abort = new AbortController();

    _session = {
        editor,
        originalText: code,
        range,
        proposed: '',
        done: false,
        abort,
        disposables: [],
    };

    vscode.commands.executeCommand('setContext', 'codico.inlineDiffVisible', true);

    // Status bar accept / reject buttons
    const acceptBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 200);
    acceptBar.text = '$(check) Accept  [Ctrl+Enter]';
    acceptBar.tooltip = 'Accept the AI edit';
    acceptBar.command = 'codico.acceptInlineDiff';
    acceptBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    acceptBar.show();

    const rejectBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 199);
    rejectBar.text = '$(x) Discard  [Escape]';
    rejectBar.tooltip = 'Discard the AI edit';
    rejectBar.command = 'codico.rejectInlineDiff';
    rejectBar.show();

    // Auto-dismiss when cursor moves far outside the affected range (10-line buffer each side).
    const moveSub = vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor !== editor) { return; }
        const curLine = e.selections[0]?.active.line ?? -1;
        if (curLine < range.start.line - 10 || curLine > range.end.line + 10) { _reject(); }
    });

    // Dismiss if the editor is closed while the stream is running — otherwise the
    // status bar buttons and HTTP connection would live until the extension host exits.
    const editorCloseSub = vscode.window.onDidChangeVisibleTextEditors((visible) => {
        if (_session && !visible.includes(_session.editor)) { _reject(); }
    });

    // acceptBar, rejectBar, moveSub, and editorCloseSub are all owned exclusively by
    // _session.disposables. _clearSession() disposes them on accept/reject/close.
    _session.disposables.push(acceptBar, rejectBar, moveSub, editorCloseSub);

    // Snapshot the session object at stream-start so the onToken callback can verify
    // identity — if a second handleInlineChat call replaces _session mid-stream, tokens
    // from this stream must not be written into the new session.
    const mySession = _session;

    try {
        await streamEdit(apiKey, model, instruction, code, language, abort.signal, (delta) => {
            if (_session !== mySession) { return; }
            mySession.proposed += delta;
            _applyDecorations(mySession);
        });
        if (_session === mySession) {
            mySession.done = true;
            _applyDecorations(mySession);
        }
    } catch (err: unknown) {
        if (!abort.signal.aborted) {
            _clearSession();
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Codico inline chat error: ${message}`);
        }
    }
}
