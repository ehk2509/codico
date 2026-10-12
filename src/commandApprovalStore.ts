import * as vscode from 'vscode';
import { addRule, allowedBy, isValidRule, isWildcardRule, suggestRules } from './commandApprovals';

export const APPROVED_COMMANDS_KEY = 'codico.approvedCommands.v1';

/**
 * The commands the user always allows in this workspace. Kept in the workspace's private
 * state, not in a settings file: a repository must not be able to approve its own commands.
 */
export class CommandApprovalStore {
    /** The rules offered on each open approval card, so that only an offered rule can be saved. */
    private readonly _offered = new Map<string, string[]>();

    constructor(private readonly _state: () => vscode.Memento) {}

    get rules(): string[] {
        const stored = this._state().get<unknown>(APPROVED_COMMANDS_KEY, []);
        return Array.isArray(stored) ? stored.filter(isValidRule) : [];
    }

    /** The rule that allows this command without asking, if any. */
    allows(command: string): string | undefined {
        return vscode.workspace.isTrusted ? allowedBy(this.rules, command) : undefined;
    }

    /** The rules to offer on the approval card of this command. */
    offer(permId: string, command: string): string[] {
        const rules = suggestRules(command);
        if (this._offered.size > 200) { this._offered.clear(); } // cards answered with Allow All are never reported back
        this._offered.set(permId, rules);
        return rules;
    }

    /** The card was answered; `rule` is the one the user chose to remember, if any. */
    async answered(permId: string, rule: string | undefined): Promise<void> {
        const offered = this._offered.get(permId) ?? [];
        this._offered.delete(permId);
        if (rule !== undefined && offered.includes(rule)) { await this._state().update(APPROVED_COMMANDS_KEY, addRule(this.rules, rule)); }
    }

    /** "Codico: Remembered Commands": the list, to remove from. */
    async manage(): Promise<void> {
        const rules = this.rules;
        if (rules.length === 0) {
            void vscode.window.showInformationMessage('Codico: no command is always allowed in this workspace. Choose "Always allow" on a command\'s approval card to add one.');
            return;
        }
        const kept = await vscode.window.showQuickPick(
            rules.map(rule => ({ label: rule, description: isWildcardRule(rule) ? 'with any arguments' : 'exactly this command', picked: true })),
            { canPickMany: true, title: 'Commands Codico runs without asking in this workspace', placeHolder: 'Untick a command to ask for it again, then press Enter' });
        if (!kept) { return; }
        const keep = new Set(kept.map(item => item.label));
        await this._state().update(APPROVED_COMMANDS_KEY, rules.filter(rule => keep.has(rule)));
        const removed = rules.length - keep.size;
        if (removed > 0) { void vscode.window.showInformationMessage(`Codico: ${removed} command${removed === 1 ? '' : 's'} will be asked about again.`); }
    }
}
