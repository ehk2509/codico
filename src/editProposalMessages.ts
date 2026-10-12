import { ExtensionMessage, WebviewMessage } from './chatProtocol';
import { EditProposalManager, UndoPush } from './editProposalManager';
import { UndoRedoStack } from './undoRedoStack';

export type ProposalMessage = Extract<WebviewMessage, { type: 'previewEditDiff' | 'acceptEdit' | 'rejectEdit' | 'acceptAllEdits' | 'rejectAllEdits' | 'acceptHunk' | 'rejectHunk' }>;

/** The review of proposed edits (Edits mode): whole files, all files, or one change of a file. */
export async function handleProposalMessage(
    msg: ProposalMessage, proposals: EditProposalManager, undo: UndoRedoStack,
    post: (message: ExtensionMessage) => void, confirm: (message: string) => Promise<boolean>,
): Promise<void> {
    const record: UndoPush = (before, after, filepath, label, uri) => undo.push({ filepath, uri, before, after, label });
    // What is left to review, or nothing
    const remaining = () => post(proposals.hasProposals ? { type: 'proposalsReady', proposals: proposals.webviewState } : { type: 'allProposalsResolved' });
    switch (msg.type) {
        case 'previewEditDiff':
            await proposals.openDiff(msg.filepath);
            return;
        case 'acceptEdit':
            // Not applied: the file changed meanwhile and the user kept it; the proposal stays
            if (!await proposals.applyOne(msg.filepath, record, confirm)) { return; }
            post({ type: 'proposalAccepted', filepath: msg.filepath });
            post({ type: 'undoRedoState', ...undo.state });
            if (!proposals.hasProposals) { post({ type: 'allProposalsResolved' }); }
            return;
        case 'rejectEdit':
            proposals.rejectOne(msg.filepath);
            post({ type: 'proposalRejected', filepath: msg.filepath });
            if (!proposals.hasProposals) { post({ type: 'allProposalsResolved' }); }
            return;
        case 'acceptHunk':
            if (!await proposals.applyHunk(msg.filepath, msg.index, record, confirm)) { return; }
            post({ type: 'undoRedoState', ...undo.state });
            remaining();
            return;
        case 'rejectHunk':
            if (proposals.rejectHunk(msg.filepath, msg.index)) { remaining(); }
            return;
        case 'acceptAllEdits':
            await proposals.applyAll(record, confirm);
            post({ type: 'undoRedoState', ...undo.state });
            // Proposals for files the user chose to keep stay open for review
            remaining();
            return;
        case 'rejectAllEdits':
            proposals.rejectAll();
            post({ type: 'allProposalsResolved' });
    }
}
