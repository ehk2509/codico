import { ChatMessage } from './openRouterClient';

/** Longest message taken in mid-task; a longer one waits for the reply to end, as before. */
export const MAX_STEER_CHARS = 8000;

/** Closes a turn the user stopped after its tools had run, so the conversation still alternates. */
export const STOPPED_NOTE = '(The user stopped the task here, before I replied to these results.)';

/** How a message the user sent while the agent was working is put to the model. */
export function steerText(text: string): string {
    return '[Message from the user, sent while you were working on the task above]\n' + text.trim() +
        '\n[End of the message. Take it into account from now on: if it changes or corrects the task, follow it; if it asks a question, answer it in your reply.]';
}

/**
 * Adds the message to the conversation at the point the agent has reached. It joins the
 * tool results that are about to be sent, so that no provider sees two user turns in a row
 * or a user turn between a tool call and its result.
 */
export function addSteer(history: ChatMessage[], text: string): void {
    const last = history[history.length - 1];
    const steer = steerText(text);
    if (last && (last.role === 'tool' || last.role === 'user') && typeof last.content === 'string') {
        last.content += '\n\n' + steer;
    } else {
        history.push({ role: 'user', content: steer });
    }
}

/** What the reply shows where the message was taken in. */
export function steerNote(text: string): string {
    const shown = text.trim().replace(/\s*\n\s*/g, ' ');
    return `\n\n> 💬 **You, while Codico was working:** ${shown.length > 400 ? shown.slice(0, 400) + '…' : shown}\n\n`;
}
