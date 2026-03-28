# VibeAround Telegram Plugin

Telegram channel plugin for VibeAround. Communicates with the Rust host via stdio JSON-RPC 2.0.

## Architecture

```
Telegram User ←→ Long Polling (grammY) ←→ Plugin (Node.js) ←→ stdio JSON-RPC ←→ Rust Host
```

The plugin runs as a child process of the host. Messages are exchanged over stdin/stdout:
- Host → Plugin: `initialize`, `send_text`, `agent_start`, `agent_token`, `agent_end`, etc.
- Plugin → Host: `on_message`, `on_callback` notifications

## Features

- **Block-based rendering**: each contiguous run of the same variant (thinking, tool use, text) becomes a separate message. Within each block, streaming is done via `sendMessage` + `editMessageText`. When the variant changes, the current block is sealed and a new message starts.
- **sendChain message ordering**: all `flushBlock` calls are serialized via a promise chain to prevent out-of-order delivery
- **Typing indicator interval**: a typing indicator is shown periodically during agent turns
- Powered by [grammY](https://grammy.dev/) with [@grammyjs/auto-retry](https://grammy.dev/plugins/auto-retry)
- Long polling mode (no public URL required)
- Automatic message splitting for content > 4096 characters
- Callback query (inline keyboard) support
- Private and group chat support
- `/help` slash command returns cached agent commands + system commands

## Project Structure

```
src/
├── main.ts              # Entry point, JSON-RPC router
├── stdio.ts             # JSON-RPC 2.0 transport
├── stdout-guard.ts      # stdout interceptor (protects JSON-RPC channel)
├── protocol.ts          # Host ↔ Plugin protocol types
├── bot.ts               # grammY bot + long polling + message listener
└── agent-stream.ts      # Agent events → block-based message rendering
```

## Development

```bash
npm install
npm run build

# Watch mode
npm run dev
```

## Configuration

Add to VibeAround's `settings.json`:

```json
{
  "channels": {
    "telegram": {
      "bot_token": "123456:ABC-DEF..."
    }
  }
}
```

### Telegram Bot Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts to create a bot
3. Copy the bot token into `settings.json`
4. Optional: Use `/setcommands` to register slash commands (e.g. `/new`, `/status`, `/help`)

## Protocol

JSON-RPC 2.0 over stdio, newline-delimited. See `src/protocol.ts` for details.

## Rendering

Agent output uses block-based rendering. Each contiguous run of the same variant (thinking, tool use, text) is streamed within a single message via `sendMessage` followed by `editMessageText` updates. When the variant changes, the current block is sealed (no further edits) and a new message is created for the next block. All block flushes are serialized through `sendChain` to guarantee correct ordering.
