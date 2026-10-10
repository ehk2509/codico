import * as vscode from 'vscode';
import { DIRECT_PROVIDERS, directSecretKey, getDirectProvider, parseDirectModelId, pickDirectFallback } from './directProviderClient';

/**
 * The model to run a request with. An OpenRouter model cannot run without an OpenRouter
 * key; when a direct provider key is set instead (for example only a DeepSeek key), the
 * setting is switched to that provider's model rather than failing with "set an OpenRouter
 * key". The user is told, and can pick another model in the chat header.
 */
export async function usableModel(context: vscode.ExtensionContext, model: string): Promise<string> {
    if (model.startsWith('ollama/') || model.startsWith('direct:')) { return model; }
    if (await context.secrets.get('openRouterApiKey')) { return model; }
    const keyed: string[] = [];
    for (const provider of DIRECT_PROVIDERS) {
        if (await context.secrets.get(directSecretKey(provider.id))) { keyed.push(provider.id); }
    }
    const fallback = pickDirectFallback(model, keyed);
    if (!fallback) { return model; }
    await vscode.workspace.getConfiguration('codico').update('model', fallback, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`Codico: no OpenRouter key is set, so it now uses ${directModelLabel(fallback)}. Pick another model in the chat header at any time.`);
    return fallback;
}

/** "DeepSeek V4.1 Flash (your DeepSeek key)" for a `direct:` model id. */
export function directModelLabel(model: string): string {
    const parsed = parseDirectModelId(model);
    const provider = parsed ? getDirectProvider(parsed.providerId) : undefined;
    const name = provider?.models.find(m => m.id === parsed?.modelId)?.displayName ?? model;
    return provider ? `${name} (your ${provider.name} key)` : name;
}

/** The provider a model id belongs to, as the chat header names it. */
export function providerOfModel(model: string): string {
    if (model.startsWith('ollama/')) { return 'ollama'; }
    const parsed = parseDirectModelId(model);
    return parsed ? `direct:${parsed.providerId}` : 'openrouter';
}

/** Which providers have an API key (Ollama needs none), keyed like providerOfModel(). */
export async function providerKeyStatus(context: vscode.ExtensionContext): Promise<Record<string, boolean>> {
    const status: Record<string, boolean> = { ollama: true, openrouter: !!await context.secrets.get('openRouterApiKey') };
    for (const provider of DIRECT_PROVIDERS) {
        status[`direct:${provider.id}`] = !!await context.secrets.get(directSecretKey(provider.id));
    }
    return status;
}

/** After the user picks a model of a provider that has no key yet: ask for that key. */
export async function promptForMissingKey(context: vscode.ExtensionContext, model: string): Promise<void> {
    const provider = providerOfModel(model);
    if ((await providerKeyStatus(context))[provider]) { return; }
    if (provider === 'openrouter') { await vscode.commands.executeCommand('codico.setApiKey'); }
    else { await vscode.commands.executeCommand('codico.setDirectApiKey', provider.slice('direct:'.length)); }
}
