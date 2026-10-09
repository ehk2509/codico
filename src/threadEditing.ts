import { DisplayMessage } from './chatProtocol';
import { ChatMessage, MessageContentPart } from './openRouterClient';

/** What a turn sent, so it can be sent again (regenerate) or edited and resent. */
export interface TurnToRedo {
    /** The text to send: the user's words, or the full prompt when it differs from what was shown. */
    text: string;
    /** Set for a Plan-mode turn: its goal. */
    plan?: string;
    /** Images attached to the turn. */
    parts?: MessageContentPart[];
    /** What the panel showed instead of the text (an approved plan's execution prompt); not editable. */
    shownAs?: string;
}

export type CutResult =
    | { display: DisplayMessage[]; history: ChatMessage[]; turn: TurnToRedo }
    | { error: string };

/**
 * Cuts the conversation back to just before a turn, in both the transcript the panel
 * shows and the history the model sees, so the two keep matching.
 */
export function cutAtTurn(display: DisplayMessage[], history: ChatMessage[], turnId: string): CutResult {
    const shown = display.findIndex(m => m.role === 'user' && m.id === turnId);
    if (shown < 0) { return { error: 'That message is no longer in this conversation.' }; }
    const sent = history.findIndex(m => m.role === 'user' && m.turnId === turnId);
    if (sent < 0) {
        return { error: 'That message was summarised when the conversation was compacted, so it can no longer be changed.' };
    }
    const message = display[shown];
    const content = history[sent].content;
    const parts = Array.isArray(content) ? content.filter(part => part.type !== 'text') : [];
    return {
        display: display.slice(0, shown),
        history: history.slice(0, sent),
        turn: {
            text: message.prompt ?? message.text,
            plan: message.plan,
            parts: parts.length > 0 ? parts : undefined,
            shownAs: message.prompt !== undefined ? message.text : undefined,
        },
    };
}

/** The newest turn that can be regenerated. */
export function lastTurnId(display: DisplayMessage[]): string | undefined {
    for (let i = display.length - 1; i >= 0; i--) {
        if (display[i].role === 'user' && display[i].id) { return display[i].id; }
    }
    return undefined;
}
