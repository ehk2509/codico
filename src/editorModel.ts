import * as vscode from 'vscode';

/**
 * Editor features (completions, next-edit suggestions, rename, inline chat, commit
 * messages) call OpenRouter, and only inline completions also support Ollama. With
 * another model selected every request would be rejected, so they are not sent.
 */
export function unsupportedEditorModel(model: string, ollamaSupported = false): boolean {
    return model.startsWith('direct:') || (!ollamaSupported && model.startsWith('ollama/'));
}

export function unsupportedModelMessage(feature: string, model: string, ollamaSupported = false): string {
    return `Codico: ${feature} ${ollamaSupported ? 'need an OpenRouter or Ollama model' : 'needs an OpenRouter model'}; the selected model (${model}) is not supported here.`;
}

const notified = new Set<string>();

/** For features that run while typing: says so once per session instead of failing silently. */
export function notifyUnsupportedModelOnce(feature: string, model: string, ollamaSupported = false): void {
    const key = `${feature}|${model}`;
    if (notified.has(key)) { return; }
    notified.add(key);
    void vscode.window.showInformationMessage(unsupportedModelMessage(feature, model, ollamaSupported));
}
