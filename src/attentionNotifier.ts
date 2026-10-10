import * as vscode from 'vscode';
import { AttentionMode, decideAttention, desktopNotify } from './attention';
import { ExtensionMessage } from './chatProtocol';

/** A notification inside VS Code that is still showing: the same text is not stacked on it. */
let showing: string | undefined;
/** Two desktop notifications closer than this are merged into the first (a burst of approval requests). */
const DESKTOP_GAP_MS = 3000;
let lastDesktopAt = 0;

/**
 * Called for every message sent to the chat panel: notifies the user when the message means
 * "finished" or "waiting for you" and they are not looking at the chat.
 */
export function noteAttention(msg: ExtensionMessage, chatVisible: boolean): void {
    // Automated runs have nobody to notify
    if (process.env.CODICO_EVAL_MODE === '1') { return; }
    const mode = vscode.workspace.getConfiguration('codico').get<AttentionMode>('notifications', 'whenAway');
    const decision = decideAttention(msg, { mode, windowFocused: vscode.window.state.focused, chatVisible });
    if (!decision) { return; }
    // A remote window's extension runs on the other machine: a desktop notification there reaches nobody
    if (decision.desktop && !vscode.env.remoteName && Date.now() - lastDesktopAt > DESKTOP_GAP_MS) {
        lastDesktopAt = Date.now();
        desktopNotify(vscode.workspace.name ? `Codico — ${vscode.workspace.name}` : 'Codico', decision.text);
    }
    if (showing === decision.text) { return; }
    showing = decision.text;
    void vscode.window.showInformationMessage(decision.text, 'Show Codico').then(choice => {
        showing = undefined;
        if (choice) { void vscode.commands.executeCommand('codico.chatView.focus'); }
    }, () => { showing = undefined; });
}
