export class StreamCompletionGuard {
    private _terminalSeen = false;

    markTerminal(): void {
        this._terminalSeen = true;
    }

    get terminalSeen(): boolean {
        return this._terminalSeen;
    }

    unexpectedEofMessage(provider: string): string | null {
        if (this._terminalSeen) { return null; }
        return `${provider} stream interrupted: connection closed before the provider sent a completion marker.`;
    }
}

export function isRecoverableStreamInterruption(message: string): boolean {
    return /stream interrupted: connection closed before|stream transport error:/i.test(message);
}

export function normalizeFinishReason(reason: string): string {
    const normalized = reason.trim().toLowerCase();
    if (normalized === 'max_tokens' || normalized === 'max_output_tokens' || normalized === 'max_tokens_reached') {
        return 'length';
    }
    if (normalized === 'safety' || normalized === 'recitation' || normalized === 'blocked') {
        return 'content_filter';
    }
    return normalized;
}
