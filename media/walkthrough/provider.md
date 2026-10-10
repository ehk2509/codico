## Choose how Codico runs models

Codico needs a model provider. Pick one — you can switch at any time with the **Provider** menu at the top of the chat.

| Provider | What you need |
|---|---|
| **OpenRouter** | One API key for hundreds of models, including free ones (openrouter.ai) |
| **Claude Code** | Your Claude plan. No key: the `claude` command, signed in |
| **ChatGPT** | Your ChatGPT plan. No key: `npm install -g @openai/codex`, then `codex login` |
| **Your own key** | Anthropic, OpenAI, Google, DeepSeek, Groq, Mistral, Grok or Cerebras |
| **Ollama** | Models that run on this machine: private and free |

Keys are stored in VS Code's secret storage, never in your settings or your project.
