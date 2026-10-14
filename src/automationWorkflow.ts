/**
 * The GitHub Actions workflow that runs `codico automate` on GitHub's own events: an issue
 * labelled, a CI run finished, a review submitted, checks finished on a pull request, and a
 * schedule in case one is missed. Nothing here touches the disk.
 */

/** The secret that holds the model's key, by provider (the names `codico` reads from the environment). */
export const KEY_SECRET: Record<string, string> = {
    openrouter: 'OPENROUTER_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_API_KEY', groq: 'GROQ_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY', mistral: 'MISTRAL_API_KEY', xai: 'XAI_API_KEY', cerebras: 'CEREBRAS_API_KEY',
};

/** The key a model needs: its provider's for a direct model, OpenRouter's otherwise. Undefined for models that need none here. */
export function keySecretFor(model: string): string | undefined {
    if (model.startsWith('ollama/') || /^(?:claude-code|chatgpt)\//.test(model)) { return undefined; }
    const direct = /^direct:([^/]+)\//.exec(model);
    return direct ? KEY_SECRET[direct[1]] : KEY_SECRET.openrouter;
}

/** The names of a repository's other workflows, from their files ("name:" at the top level, or the file name). */
export function workflowNames(files: Array<{ file: string; text: string }>): string[] {
    return files.filter(f => !/^codico\.ya?ml$/.test(f.file)).map(f => /^name:\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/m.exec(f.text)?.[1].trim() || f.file.replace(/\.ya?ml$/, ''));
}

const quote = (text: string) => JSON.stringify(text);

export interface WorkflowOptions {
    label: string;
    /** Workflows whose failure on the default branch is a job (their "name:"). */
    ciWorkflows: string[];
    model: string;
    /** The repository Codico's release is downloaded from. */
    codicoRepo: string;
}

/** The workflow file. */
export function workflowYaml(options: WorkflowOptions): string {
    const key = keySecretFor(options.model);
    const ci = options.ciWorkflows.length > 0;
    return `# Codico automations: issues labelled "${options.label}"${ci ? ' and CI failures on the default branch' : ''} become draft pull requests;
# CI failures and requested changes on those pull requests are worked on by the same agent, with its conversation.
#
# Secrets to add in the repository's settings (Settings > Secrets and variables > Actions):
${key ? `#   ${key}: the key of the model (${options.model})\n` : ''}#   CODICO_GITHUB_TOKEN (recommended): a fine-grained token with contents, pull requests and issues (write) and actions (read).
#     Pull requests and pushes made with the workflow's own GITHUB_TOKEN do not start other workflows, so without it
#     your CI does not run on Codico's pull requests, and there is no CI result for Codico to act on.
name: Codico

on:
  issues:
    types: [labeled, opened]
${ci ? `  workflow_run:\n    workflows: [${options.ciWorkflows.map(quote).join(', ')}]\n    types: [completed]\n` : ''}  pull_request_review:
    types: [submitted]
  check_suite:
    types: [completed]
  schedule:
    - cron: '17 * * * *'
  workflow_dispatch:

# One run at a time: they share what Codico remembers (its jobs and their conversations)
concurrency:
  group: codico-automate
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write
  issues: read
  actions: read
  checks: read

jobs:
  automate:
    # Not for Codico's own events (its pushes would start it again)
    if: github.actor != 'github-actions[bot]'
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: \${{ secrets.CODICO_GITHUB_TOKEN || github.token }}

      - name: VS Code and Codico
        run: |
          mkdir -p "$RUNNER_TEMP/vscode" "$RUNNER_TEMP/codico"
          curl -fsSL "https://update.code.visualstudio.com/latest/linux-x64/stable" | tar -xz -C "$RUNNER_TEMP/vscode" --strip-components=1
          curl -fsSL -o "$RUNNER_TEMP/codico.vsix" "https://github.com/${options.codicoRepo}/releases/latest/download/codico.vsix"
          unzip -q "$RUNNER_TEMP/codico.vsix" 'extension/*' -d "$RUNNER_TEMP/codico"

      # What Codico remembers between runs: its jobs, their conversations and worktrees
      - uses: actions/cache@v4
        with:
          path: \${{ runner.temp }}/codico-state
          key: codico-state-\${{ github.run_id }}
          restore-keys: codico-state-

      - name: Codico
        env:
          GITHUB_TOKEN: \${{ secrets.CODICO_GITHUB_TOKEN || github.token }}
${key ? `          ${key}: \${{ secrets.${key} }}\n` : ''}          CODICO_VSCODE: \${{ runner.temp }}/vscode/code
        run: |
          xvfb-run -a node "$RUNNER_TEMP/codico/extension/bin/codico.js" automate \\
            --state-dir "$RUNNER_TEMP/codico-state" \\
            --label ${quote(options.label)}${ci ? '' : ' --no-ci'} \\
            --model ${quote(options.model)} \\
            --allow-commands --publish
`;
}
