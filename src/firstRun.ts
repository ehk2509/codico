import * as vscode from 'vscode';
import { providerKeyStatus } from './modelFallback';
import { shouldOnboard } from './onboarding';

const ONBOARDED_KEY = 'codico.onboarded';
export const WALKTHROUGH_ID = 'codico.codico#codico.gettingStarted';

export function openWalkthrough(): Thenable<unknown> {
    return vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false);
}

/** First run after install: opens the guide once. Never in development or test runs. */
export async function onboardOnFirstRun(context: vscode.ExtensionContext): Promise<void> {
    if (context.extensionMode !== vscode.ExtensionMode.Production) { return; }
    const onboarded = context.globalState.get<boolean>(ONBOARDED_KEY, false);
    if (onboarded) { return; }
    await context.globalState.update(ONBOARDED_KEY, true);
    const model = vscode.workspace.getConfiguration('codico').inspect<string>('model');
    const modelChosen = model?.globalValue !== undefined || model?.workspaceValue !== undefined || model?.workspaceFolderValue !== undefined;
    if (shouldOnboard({ onboarded, keys: await providerKeyStatus(context), modelChosen })) { await openWalkthrough(); }
}
