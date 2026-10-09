import * as vscode from 'vscode';
import * as path from 'path';
import { readCurrentBytes, revealFile, sameBytes, writeCurrentBytes } from './workspaceText';

export interface FileEditProposal {
    /** Path as the model wrote it; identifies the proposal in the panel. */
    filepath: string;
    /** The resolved file (the path may be absolute or name another workspace folder). */
    uri: vscode.Uri;
    /** Raw bytes of the file before this change. `null` means the file is new. */
    originalContent: Uint8Array | null;
    proposedContent: string;
    label: string;
}

export type UndoPush = (before: Uint8Array | null, after: Uint8Array, fp: string, label: string, uri: vscode.Uri) => void;

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
    /** Keyed by resolved file, so two spellings of one path share a proposal. */
    private readonly _proposals = new Map<string, FileEditProposal>();
    private readonly _provider = new ProposedContentProvider();

    /** Call once at extension activation to register the virtual-document provider. */
    register(context: vscode.ExtensionContext): void {
        context.subscriptions.push(
            vscode.workspace.registerTextDocumentContentProvider(SCHEME, this._provider)
        );
    }

    /** Add or replace the proposal for a file. */
    queue(proposal: FileEditProposal): void {
        const key = proposal.uri.toString();
        // A later edit to the same file keeps the name the panel already shows
        const filepath = this._proposals.get(key)?.filepath ?? proposal.filepath;
        this._provider.set(filepath, proposal.proposedContent);
        this._proposals.set(key, { ...proposal, filepath });
    }

    /** The queued proposal for a file, if any (later edits must build on it, not on disk). */
    pending(uri: vscode.Uri): FileEditProposal | undefined { return this._proposals.get(uri.toString()); }

    private _byPath(filepath: string): FileEditProposal | undefined {
        return [...this._proposals.values()].find(p => p.filepath === filepath);
    }

    get hasProposals(): boolean { return this._proposals.size > 0; }
    get count(): number { return this._proposals.size; }
    get proposals(): FileEditProposal[] { return [...this._proposals.values()]; }

    /** Open a VS Code side-by-side diff for a single proposal. */
    async openDiff(filepath: string): Promise<void> {
        const proposal = this._byPath(filepath);
        if (!proposal) { return; }

        const proposedUri = this._provider.uri(filepath);
        // Ensure provider has fresh content
        this._provider.set(filepath, proposal.proposedContent);

        let originalUri: vscode.Uri;
        if (proposal.originalContent !== null) {
            originalUri = proposal.uri;
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
     * Calls `undoPush` with (before, after, filepath, label, uri) so callers can
     * integrate with the UndoRedoStack without a direct dependency.
     */
    async applyOne(
        filepath: string,
        undoPush: UndoPush,
        confirm: (message: string) => Promise<boolean>
    ): Promise<boolean> {
        const proposal = this._byPath(filepath);
        if (!proposal) { return false; }

        // Resolved (and checked) by the workspace path rules when the proposal was made
        const fileUri = proposal.uri;
        const encoded = new TextEncoder().encode(proposal.proposedContent);

        // The proposal was built on the file as it was then; changes made since would be lost
        if (!sameBytes(await readCurrentBytes(fileUri), proposal.originalContent) &&
            !await confirm(`${filepath} has changed since Codico proposed this edit. Apply it anyway and lose those changes?`)) {
            return false;
        }
        await writeCurrentBytes(fileUri, encoded);

        undoPush(proposal.originalContent, encoded, filepath, proposal.label, fileUri);

        this._proposals.delete(fileUri.toString());
        this._provider.delete(filepath);

        await revealFile(fileUri);
        return true;
    }

    /** Apply every queued proposal in order. Returns list of applied filepaths. */
    async applyAll(
        undoPush: UndoPush,
        confirm: (message: string) => Promise<boolean>
    ): Promise<string[]> {
        const applied: string[] = [];
        for (const fp of this.proposals.map(p => p.filepath)) {
            if (await this.applyOne(fp, undoPush, confirm)) { applied.push(fp); }
        }
        return applied;
    }

    rejectOne(filepath: string): void {
        const proposal = this._byPath(filepath);
        if (proposal) { this._proposals.delete(proposal.uri.toString()); }
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
