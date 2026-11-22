/** Model discovery, pre-flight checks and plain-language errors for the standalone CLI. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DIRECT_PROVIDERS, parseDirectModelId } from '../directProviderClient';
import { CLAUDE_CODE_MODELS } from '../claudeCodeClient';
import { KEY_FOR_PROVIDER } from './agent';
import { locate } from './cliProviders';
import type { Choice } from './tui/select';

export const CUSTOM_MODEL = '\u0000custom';

/**
 * Models served at the local endpoint: Ollama's /api/tags, or the OpenAI-compatible /v1/models that
 * llama.cpp, LM Studio, vLLM and similar servers expose.
 */
export async function ollamaModels(url: string): Promise<string[] | Error> {
    const base = url.replace(/\/+$/, '');
    let failure: Error = new Error('no answer');
    try {
        const response = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(2500) });
        if (response.ok) {
            const body = await response.json() as { models?: { name: string }[] };
            if (Array.isArray(body.models)) { return body.models.map(m => m.name); }
        }
        failure = new Error(`HTTP ${response.status}`);
    } catch (error) { failure = error as Error; }
    try {
        const response = await fetch(base + '/v1/models', { signal: AbortSignal.timeout(2500) });
        if (!response.ok) { return new Error(`HTTP ${response.status}`); }
        const body = await response.json() as { data?: { id: string }[] };
        if (Array.isArray(body.data)) { return body.data.map(m => m.id); }
    } catch { /* report the first failure */ }
    return failure;
}

function cliFound(model: 'claude-code' | 'chatgpt'): boolean {
    const cli = model === 'claude-code'
        ? locate('claude', 'CODICO_CLAUDE_PATH', '@anthropic-ai/claude-code', 'cli.js')
        : locate('codex', 'CODICO_CODEX_PATH', '@openai/codex', 'bin/codex.js');
    return path.isAbsolute(cli.command) && fs.existsSync(cli.command);
}

/** Everything this machine can use right now: pulled Ollama models, logged-in CLIs, providers with keys. */
export async function modelChoices(current: string, ollamaUrl: string): Promise<Choice<string>[]> {
    const choices: Choice<string>[] = [];
    const add = (value: string, label: string, hint: string): void => {
        if (!choices.some(c => c.value === value)) { choices.push({ value, label, hint, current: value === current }); }
    };
    const local = await ollamaModels(ollamaUrl);
    if (Array.isArray(local)) {
        for (const name of local) { add('ollama/' + name, name, 'runs on this computer'); }
    }
    if (cliFound('claude-code')) {
        for (const name of CLAUDE_CODE_MODELS) { add('claude-code/' + name, `Claude ${name[0].toUpperCase() + name.slice(1)}`, 'your Claude Code login'); }
    }
    if (cliFound('chatgpt')) { add('chatgpt/gpt-5', 'ChatGPT (Codex)', 'your ChatGPT login'); }
    for (const provider of DIRECT_PROVIDERS) {
        const key = KEY_FOR_PROVIDER[provider.id];
        if (!key || !process.env[key]) { continue; }
        for (const model of provider.models.slice(0, 4)) { add(`direct:${provider.id}/${model.id}`, model.displayName, `${provider.name} · ${key}`); }
    }
    if (current && !choices.some(c => c.value === current)) {
        choices.unshift({ value: current, label: current, hint: 'current', current: true });
    }
    choices.push({ value: CUSTOM_MODEL, label: 'Other…', hint: 'type a model ID (OpenRouter, direct:provider/model, ollama/name)' });
    return choices;
}

/** Why the model cannot be used right now, in plain words, or undefined if it looks usable. */
export async function modelProblem(model: string, ollamaUrl: string): Promise<string | undefined> {
    if (model.startsWith('ollama/')) {
        const found = await ollamaModels(ollamaUrl);
        if (found instanceof Error) { return `No local model server is answering at ${ollamaUrl} (is Ollama or your model server running?).`; }
        const name = model.slice(7);
        if (!found.some(m => m === name || m === name + ':latest')) { return `The model "${name}" isn't available on the local server at ${ollamaUrl}.`; }
        return undefined;
    }
    if (model.startsWith('claude-code/')) { return cliFound('claude-code') ? undefined : 'Claude Code (the "claude" command) isn\'t installed.'; }
    if (model.startsWith('chatgpt/')) { return cliFound('chatgpt') ? undefined : 'The Codex CLI (the "codex" command) isn\'t installed.'; }
    const direct = parseDirectModelId(model);
    if (model.startsWith('direct:') && !direct) { return `"${model}" isn't a valid model ID (expected direct:provider/model).`; }
    const key = direct ? KEY_FOR_PROVIDER[direct.providerId] : 'OPENROUTER_API_KEY';
    if (!key) { return `Codico doesn't know the provider "${direct?.providerId}".`; }
    if (!process.env[key]) { return `${key} isn't set, so ${direct ? direct.providerId : 'OpenRouter'} can't be used.`; }
    return undefined;
}

/** Turn a raw provider/agent error into a short explanation and a next step. */
export function friendlyError(message: string, model: string, ollamaUrl: string): { title: string; hint?: string; modelIssue?: boolean; stepLimit?: boolean } {
    const raw = message.replace(/\s+/g, ' ').trim();
    const name = model.replace(/^ollama\//, '');
    if (/invalid direct model|unsupported provider/i.test(raw)) {
        return { title: `"${model}" isn't a model Codico can use.`, hint: 'Choose another with /model', modelIssue: true };
    }
    if (/model ['"]?[^'"]*['"]? not found|not_found_error|model not found/i.test(raw) && model.startsWith('ollama/')) {
        return { title: `The model "${name}" isn't installed in Ollama.`, hint: `Choose another with /model, or install it: ollama pull ${name}`, modelIssue: true };
    }
    if (/ECONNREFUSED|fetch failed|connect ETIMEDOUT|socket hang up/i.test(raw) && model.startsWith('ollama/')) {
        return { title: `Can't reach Ollama at ${ollamaUrl}.`, hint: 'Start Ollama (open the app or run: ollama serve), or choose another model with /model', modelIssue: true };
    }
    const key = /([A-Z_]+_API_KEY) is required/.exec(raw);
    if (key) { return { title: `${key[1]} isn't set.`, hint: `Set it in your environment and restart, or choose another model with /model`, modelIssue: true }; }
    if (/\b401\b|invalid.{0,20}(api )?key|unauthori[sz]ed|authentication/i.test(raw)) {
        return { title: 'The provider rejected the API key.', hint: 'Check the key in your environment, or choose another model with /model', modelIssue: true };
    }
    if (/\b429\b|rate.?limit|quota|too many requests/i.test(raw)) {
        return { title: 'The provider is rate-limiting requests.', hint: 'Wait a moment and try again, or choose another model with /model' };
    }
    if (/insufficient.{0,20}(credit|balance|funds)|\b402\b/i.test(raw)) {
        return { title: 'The provider account is out of credit.', hint: 'Top it up, or choose another model with /model', modelIssue: true };
    }
    const steps = /Stopped after (\d+) model requests/.exec(raw);
    if (steps) { return { title: `Codico stopped after ${steps[1]} steps; the task may not be finished.`, hint: 'Say "continue" to keep going, or allow more steps: codico config set maxSteps 100', stepLimit: true }; }
    if (/ended prematurely \((length|max_tokens)\)/.test(raw)) {
        return { title: 'The reply was cut off: the model hit its output limit.', hint: 'Say "continue", or ask for a smaller step' };
    }
    if (/context.{0,20}(length|window)|too many tokens|maximum context/i.test(raw)) {
        return { title: 'The conversation is too long for this model.', hint: 'Run /compact to summarise it, or /new to start fresh' };
    }
    return { title: raw.length > 300 ? raw.slice(0, 300) + '…' : raw };
}
