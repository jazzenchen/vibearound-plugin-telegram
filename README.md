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

- Native streaming via `sendMessageDraft` (Bot API 9.5) — no flickering `editMessageText`
- Powered by [grammY](https://grammy.dev/) + [@grammyjs/stream](https://github.com/grammyjs/stream)
- Auto-retry on rate limits via [@grammyjs/auto-retry](https://grammy.dev/plugins/auto-retry)
- Long polling mode (no public URL required)
- Automatic message splitting for content > 4096 characters
- Callback query (inline keyboard) support
- Private and group chat support

## Project Structure

```
src/
├── main.ts              # Entry point, JSON-RPC router
├── stdio.ts             # JSON-RPC 2.0 transport
├── stdout-guard.ts      # stdout interceptor (protects JSON-RPC channel)
├── protocol.ts          # Host ↔ Plugin protocol types
├── bot.ts               # grammY bot + long polling + message listener
└── agent-stream.ts      # Agent events → sendMessageDraft streaming
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

## Streaming

Agent output is streamed to Telegram using the native `sendMessageDraft` API (Bot API 9.5, March 2026). This provides smooth animated text appearance without the rate-limit pressure and flickering of repeated `editMessageText` calls. The [@grammyjs/stream](https://github.com/grammyjs/stream) plugin handles batching, auto-splitting, and rate-limit retries automatically.
