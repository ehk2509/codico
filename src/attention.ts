import * as cp from 'child_process';
import { ExtensionMessage } from './chatProtocol';

/**
 * Telling the user that Codico finished, or is waiting for them, when they are not looking
 * at the chat: a desktop notification when the VS Code window is in the background, a
 * notification inside VS Code when only the chat panel is hidden.
 */

export type AttentionMode = 'off' | 'whenAway';

/** What the user would want to know about a message sent to the panel, if they are away. */
export function attentionText(msg: ExtensionMessage): string | undefined {
    const short = (text: string, max: number): string => { const line = text.trim().split('\n')[0]; return line.length > max ? `${line.slice(0, max - 1)}…` : line; };
    switch (msg.type) {
        // An empty id closes a turn that never started (a stop before the first request)
        case 'endMessage': return msg.id ? 'Codico finished its reply.' : undefined;
        case 'writePermissionRequest': return `Codico is waiting for your approval to change ${short(msg.filepath, 80)}.`;
        case 'terminalPermissionRequest': return `Codico is waiting for your approval to run: ${short(msg.command, 80)}`;
        case 'checkpoint': return 'Codico paused and asks whether to continue.';
        case 'iterationLimit': return `Codico stopped at its limit of ${msg.limit} steps.`;
        default: return undefined;
    }
}

export interface AttentionDecision {
    text: string;
    /** A desktop notification: the VS Code window is in the background. */
    desktop: boolean;
}

/** Whether a message is worth a notification, given where the user is looking. */
export function decideAttention(
    msg: ExtensionMessage,
    where: { mode: AttentionMode; windowFocused: boolean; chatVisible: boolean },
): AttentionDecision | undefined {
    if (where.mode === 'off') { return undefined; }
    // Looking at the chat: they can see it
    if (where.windowFocused && where.chatVisible) { return undefined; }
    const text = attentionText(msg);
    return text ? { text, desktop: !where.windowFocused } : undefined;
}

/** The command that shows a desktop notification on this platform, or undefined when there is none. */
export function desktopNotifyCommand(platform: NodeJS.Platform, title: string, body: string): { command: string; args: string[]; env?: Record<string, string> } | undefined {
    if (platform === 'linux') {
        return { command: 'notify-send', args: ['--app-name=Codico', '--', title, body] };
    }
    if (platform === 'darwin') {
        // The texts are passed as arguments to the script, never pasted into it
        return { command: 'osascript', args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body] };
    }
    if (platform === 'win32') {
        // The texts travel in the environment, never in the script
        const script = 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ' +
            '$n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; ' +
            '$n.ShowBalloonTip(6000, $env:CODICO_NOTIFY_TITLE, $env:CODICO_NOTIFY_BODY, [System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep -Seconds 7; $n.Dispose()';
        return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], env: { CODICO_NOTIFY_TITLE: title, CODICO_NOTIFY_BODY: body } };
    }
    return undefined;
}

/** Shows a desktop notification, best effort: a missing command or a failure is ignored. */
export function desktopNotify(title: string, body: string, platform: NodeJS.Platform = process.platform): void {
    const run = desktopNotifyCommand(platform, title, body);
    if (!run) { return; }
    try {
        const child = cp.spawn(run.command, run.args, { stdio: 'ignore', windowsHide: true, detached: false, env: { ...process.env, ...run.env } });
        child.on('error', () => { /* no notification tool on this machine */ });
        child.unref();
    } catch { /* best effort */ }
}
