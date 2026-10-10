/**
 * Token and cost accounting for one agent task (all steps of one user message),
 * plus the optional per-task token budget that pauses the agent for confirmation.
 */
export class TaskUsage {
    private _tokens = 0;
    private _cachedTokens = 0;
    private _costUsd: number | undefined;
    private _nextPause: number;

    /** @param budget tokens per pause; 0 disables the budget. */
    constructor(private readonly budget: number) {
        this.budget = Math.max(0, budget);
        this._nextPause = this.budget;
    }

    get tokens(): number { return this._tokens; }
    /** Prompt tokens the provider served from its cache (billed at a fraction of the price). */
    get cachedTokens(): number { return this._cachedTokens; }
    /** Provider-reported cost in USD, or undefined when the provider reports none. */
    get costUsd(): number | undefined { return this._costUsd; }

    add(totalTokens: number, costUsd?: number, cachedTokens = 0): void {
        this._tokens += Math.max(0, totalTokens);
        this._cachedTokens += Math.max(0, cachedTokens);
        if (costUsd !== undefined && Number.isFinite(costUsd) && costUsd >= 0) {
            this._costUsd = (this._costUsd ?? 0) + costUsd;
        }
    }

    /** True when the task has crossed the next budget threshold. */
    get budgetExceeded(): boolean {
        return this.budget > 0 && this._tokens >= this._nextPause;
    }

    /** The user chose to continue: allow another budget's worth of tokens. */
    extendBudget(): void {
        while (this.budget > 0 && this._nextPause <= this._tokens) { this._nextPause += this.budget; }
    }

    budgetPrompt(): string {
        const cost = this._costUsd !== undefined ? ` (about $${this._costUsd.toFixed(this._costUsd < 1 ? 3 : 2)})` : '';
        return `This task has used ${this._tokens.toLocaleString('en-US')} tokens${cost}, ` +
            `over your ${this.budget.toLocaleString('en-US')}-token budget. Keep going?`;
    }
}
