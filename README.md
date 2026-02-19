# chatbox-custom

A personal fork of [Chatbox](https://github.com/Bin-Huang/chatbox) with usability improvements, built through vibecoding sessions with Claude Code.

## What's different

- **Conversation tree view** — visualizes the full branching message history as an interactive node graph (React Flow). Shows which messages are in the current context window, highlights the context boundary with a divider, and lets you navigate to any branch by clicking a node. Includes a toggle for showing/hiding archived threads.

- **Context window highlighting** — messages included in the AI's active context window are marked with an orange ring directly in the chat, so you can see at a glance what the model can see.

- **Role selector** — per-session setting to control which message roles (User / Assistant / System) are included when building context for generation and compression.

- **New thread from here** — branch a new conversation from any message in the history. The full conversation tree is preserved so you can always navigate back.

- **Compress to new thread** — when compressing, choose whether to compress in place or start a fresh thread with the summary, keeping the original intact.

- **Strip message formatting** — session setting to output plain text instead of markdown.

- **Delete attachments from sent messages** — remove file or link attachments from already-sent messages, with a two-click confirmation to avoid accidents.

- **Wider scrollbar** — 12px scrollbar for easier grabbing.

## Building

Same as upstream:

```bash
pnpm install
pnpm dev
```

## Based on

[Chatbox](https://github.com/Bin-Huang/chatbox) — a desktop AI client supporting OpenAI, Claude, Gemini, and most other providers.
