# chatbox-custom

A personal fork of [Chatbox](https://github.com/Bin-Huang/chatbox) with usability improvements, built through vibecoding sessions with Claude Code.

## What's different

- **Conversation tree view** — visualizes the full branching message history as an interactive node graph (React Flow). Shows which messages are in the current context window, highlights the context boundary with a divider, and lets you navigate to any branch by clicking a node. Includes a toggle for showing/hiding archived threads.

- **New thread from here** — branch a new conversation from any message in the history, preserving context up to that point.

- **Dual compress options** — choose between compressing the full conversation or just the oldest messages when hitting context limits.

- **Strip message formatting** — session setting to output plain text instead of markdown.

- **Delete attachments from sent messages** — remove file or link attachments from already-sent messages, with a two-click confirmation to avoid accidents.

## Building

Same as upstream:

```bash
pnpm install
pnpm dev
```

## Based on

[Chatbox](https://github.com/Bin-Huang/chatbox) — a desktop AI client supporting OpenAI, Claude, Gemini, and most other providers.
