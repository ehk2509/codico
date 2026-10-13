/**
 * Token and cost accounting for one agent task (all steps of one user message),
 * plus the optional per-task token budget that pauses the agent for confirmation.
 */
/** One request of a task: prompt tokens, completion tokens, prompt tokens served from cache, and who made it. */
export type RequestRecord = [prompt: number, completion: number, cached: number, by: 'main' | 'subagent'];

/** What a task cost, request by request, kept with the reply so it can be examined afterwards. */
export interface TaskUsageRecord {
    requests: RequestRecord[];
    /** How many requests had been made when each compaction of the conversation happened. */
    compactions: number[];
    tokens: number;
    cachedTokens: number;
    costUsd?: number;
}

/** Requests kept per task; a longer task keeps its totals and its first requests. */
export const MAX_RECORDED_REQUESTS = 500;

export class TaskUsage {
    private _requests: RequestRecord[] = [];
    private _requestCount = 0;
    private _compactions: number[] = [];
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

    /** Requests made so far, by the agent and its subagents. */
    get requests(): number { return this._requestCount; }

    /** The conversation was compacted at this point of the task: what was read before is gone from it. */
    markCompaction(): void { this._compactions.push(this._requestCount); }

    /** The task request by request, or undefined when it made none. */
    record(): TaskUsageRecord | undefined {
        if (this._requestCount === 0) { return undefined; }
        return { requests: this._requests, compactions: this._compactions, tokens: this._tokens, cachedTokens: this._cachedTokens, ...(this._costUsd !== undefined ? { costUsd: this._costUsd } : {}) };
    }

    add(totalTokens: number, costUsd?: number, cachedTokens = 0, promptTokens = 0, completionTokens = 0, by: 'main' | 'subagent' = 'main'): void {
        this._requestCount++;
        if (this._requests.length < MAX_RECORDED_REQUESTS) { this._requests.push([Math.max(0, promptTokens), Math.max(0, completionTokens), Math.max(0, cachedTokens), by]); }
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
