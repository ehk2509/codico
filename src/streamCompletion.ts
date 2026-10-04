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
