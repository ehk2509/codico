import * as vscode from 'vscode';
import { DisplayMessage } from './chatProtocol';
import { RewindPlan, RewindResult, UndoRedoStack } from './undoRedoStack';

export const REWIND_ALL = 'Rewind Files and Conversation';
export const REWIND_CONVERSATION = 'Conversation Only';

/** The turns a rewind to `turnId` removes: that message and every one after it. */
export function turnsFrom(display: readonly DisplayMessage[], turnId: string): string[] {
    const start = display.findIndex(m => m.role === 'user' && m.id === turnId);
    if (start < 0) { return []; }
    return display.slice(start).filter(m => m.role === 'user' && !!m.id).map(m => m.id as string);
}

/** What the user is told before a rewind: the messages that go, the files that come back, and what cannot. */
export function rewindSummary(plan: RewindPlan, turns: number): { message: string; detail: string } {
    const message = `Rewind to before this message? ${turns === 1 ? 'It and its reply are' : `${turns} messages and their replies are`} removed from the conversation.`;
    const lines: string[] = [];
    if (plan.files.length > 0) {
        lines.push(`${plan.files.length === 1 ? '1 file is' : `${plan.files.length} files are`} put back as ${plan.files.length === 1 ? 'it was' : 'they were'} before it:`);
        for (const file of plan.files.slice(0, 12)) { lines.push(`    ${file.filepath}${file.restoreTo === null ? '  (created by Codico: deleted)' : ''}`); }
        if (plan.files.length > 12) { lines.push(`    … and ${plan.files.length - 12} more`); }
        lines.push('', 'Redo reapplies these changes one at a time.');
    } else {
        lines.push('No file change by Codico is recorded for these messages, so no file is touched.');
    }
    if (plan.incomplete) { lines.push('', 'Some of the oldest changes of these messages are no longer recorded and are not put back.'); }
    lines.push('', 'Not put back: what terminal commands changed, and changes made before VS Code was last restarted.');
    return { message, detail: lines.join('\n') };
}

/** What the user is told afterwards. */
export function rewindOutcome(result: RewindResult): string {
    const restored = result.restored.length === 0 ? 'no file changed' : `${result.restored.length} file${result.restored.length === 1 ? '' : 's'} put back`;
    return `Codico: conversation rewound, ${restored}${result.kept.length > 0 ? `; kept as ${result.kept.length === 1 ? 'it is' : 'they are'}: ${result.kept.join(', ')}` : ''}`;
}

/**
 * Asks, then puts the files of these turns back. False when the user cancelled: nothing is
 * changed then, and the conversation must be left alone too.
 */
export async function rewindFiles(stack: UndoRedoStack, turnIds: readonly string[], automated: boolean): Promise<boolean> {
    const plan = stack.planRewind(turnIds);
    let choice: string | undefined = REWIND_ALL;
    if (!automated) {
        const { message, detail } = rewindSummary(plan, turnIds.length);
        const buttons = plan.files.length > 0 ? [REWIND_ALL, REWIND_CONVERSATION] : ['Rewind Conversation'];
        choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, ...buttons);
        if (!choice) { return false; }
    }
    const result = choice === REWIND_ALL ? await stack.rewind(turnIds) : { restored: [], kept: [] };
    if (!automated) { void vscode.window.showInformationMessage(rewindOutcome(result)); }
    return true;
}
