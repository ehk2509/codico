import * as vscode from 'vscode';
import * as path from 'path';

export interface FileEditProposal {
    filepath: string;
    /** Raw bytes of the file before this change. `null` means the file is new. */
    originalContent: Uint8Array | null;
    proposedContent: string;
    label: string;
}

// ── Virtual document provider for proposed (not-yet-written) content ─────────

const SCHEME = 'copagent-proposed';

class ProposedContentProvider implements vscode.TextDocumentContentProvider {
    private readonly _contents = new Map<string, string>();
    private readonly _emitter = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._emitter.event;

    set(key: string, content: string): void {
        this._contents.set(key, content);
        this._emitter.fire(this._uri(key));
    }

    delete(key: string): void {
        this._contents.delete(key);
    }

    clear(): void {
        this._contents.clear();
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        const key = decodeURIComponent(uri.path.slice(1));
        return this._contents.get(key) ?? '';
    }

    uri(key: string): vscode.Uri {
        return this._uri(key);
    }

    private _uri(key: string): vscode.Uri {
        return vscode.Uri.parse(`${SCHEME}:/${encodeURIComponent(key)}`);
    }
}

// ── Manager ───────────────────────────────────────────────────────────────────

export class EditProposalManager {
    private readonly _proposals = new Map<string, FileEditProposal>();
    private readonly _provider = new ProposedContentProvider();

    /** Call once at extension activation to register the virtual-document provider. */
    register(context: vscode.ExtensionContext): void {
        context.subscriptions.push(
            vscode.workspace.registerTextDocumentContentProvider(SCHEME, this._provider)
        );
    }

    /** Add or replace a proposal for a filepath. */
    queue(proposal: FileEditProposal): void {
        this._provider.set(proposal.filepath, proposal.proposedContent);
        this._proposals.set(proposal.filepath, proposal);
    }

    get hasProposals(): boolean { return this._proposals.size > 0; }
    get count(): number { return this._proposals.size; }
    get proposals(): FileEditProposal[] { return [...this._proposals.values()]; }

    /** Open a VS Code side-by-side diff for a single proposal. */
    async openDiff(filepath: string): Promise<void> {
        const proposal = this._proposals.get(filepath);
        if (!proposal) { return; }

        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length) { return; }

        const proposedUri = this._provider.uri(filepath);
        // Ensure provider has fresh content
        this._provider.set(filepath, proposal.proposedContent);

        let originalUri: vscode.Uri;
        if (proposal.originalContent !== null) {
            const norm = path.posix.normalize(filepath.replace(/\\/g, '/'));
            originalUri = vscode.Uri.joinPath(folders[0].uri, norm);
        } else {
            // New file — diff against an empty document
            this._provider.set('__empty__', '');
            originalUri = this._provider.uri('__empty__');
        }

        await vscode.commands.executeCommand(
            'vscode.diff',
            originalUri,
            proposedUri,
            `${path.basename(filepath)} — AI Proposed`,
            { preview: true }
        );
    }

    /** Open diffs for all proposals (capped at 5 tabs). */
    async openAllDiffs(): Promise<void> {
        for (const fp of [...this._proposals.keys()].slice(0, 5)) {
            await this.openDiff(fp);
        }
    }

    /**
     * Apply a single proposal to disk.
     * Calls `undoPush` with (before, after, filepath, label) so callers can
     * integrate with the UndoRedoStack without a direct dependency.
     */
    async applyOne(
        filepath: string,
        undoPush: (before: Uint8Array | null, after: Uint8Array, fp: string, label: string) => void
    ): Promise<boolean> {
        const proposal = this._proposals.get(filepath);
        if (!proposal) { return false; }

        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length) { throw new Error('No workspace folder open'); }

        const norm = path.posix.normalize(filepath.replace(/\\/g, '/'));
        if (norm.startsWith('..') || path.isAbsolute(norm)) {
            throw new Error(`Unsafe file path rejected: "${filepath}"`);
        }
        const fileUri = vscode.Uri.joinPath(folders[0].uri, norm);
        const encoded = new TextEncoder().encode(proposal.proposedContent);

        // Ensure parent directories exist
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fileUri, '..'));
        await vscode.workspace.fs.writeFile(fileUri, encoded);

        undoPush(proposal.originalContent, encoded, filepath, proposal.label);

        this._proposals.delete(filepath);
        this._provider.delete(filepath);

        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
        return true;
    }

    /** Apply every queued proposal in order. Returns list of applied filepaths. */
    async applyAll(
        undoPush: (before: Uint8Array | null, after: Uint8Array, fp: string, label: string) => void
    ): Promise<string[]> {
        const applied: string[] = [];
        for (const fp of [...this._proposals.keys()]) {
            await this.applyOne(fp, undoPush);
            applied.push(fp);
        }
        return applied;
    }

    rejectOne(filepath: string): void {
        this._proposals.delete(filepath);
        this._provider.delete(filepath);
    }

    rejectAll(): void {
        this._proposals.clear();
        this._provider.clear();
    }

    /** Serialised state sent to the webview. */
    get webviewState(): Array<{ filepath: string; label: string; isNew: boolean; lines: number }> {
        return this.proposals.map(p => ({
            filepath: p.filepath,
            label: p.label,
            isNew: p.originalContent === null,
            lines: p.proposedContent.split('\n').length,
        }));
    }
}
