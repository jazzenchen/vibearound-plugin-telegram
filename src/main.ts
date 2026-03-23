#!/usr/bin/env node
/**
 * VibeAround Telegram Plugin — entry point
 *
 * Spawned by the Rust host as a child process.
 * Communicates via stdio JSON-RPC 2.0.
 *
 * Lifecycle:
 *   Host spawns → "initialize" with config
 *   → Plugin probes bot identity + starts long polling
 *   → Inbound messages → on_message notifications to Host
 *   → Host sends agent event notifications (agent_start, agent_token, agent_end, etc.)
 *   → Host sends "shutdown" → Plugin exits
 */

// MUST be first import — intercepts stdout before grammY loads
import "./stdout-guard.js";
import { setLogSink } from "./stdout-guard.js";

import { StdioTransport } from "./stdio.js";
import { TelegramBot } from "./bot.js";
import { AgentStreamHandler } from "./agent-stream.js";
import type {
  TelegramConfig,
  InitializeParams,
  InitializeResult,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

const transport = new StdioTransport();

// Wire console.error/warn from stdout-guard.ts into JSON-RPC plugin_log
setLogSink((level, message) => {
  transport.notify("plugin_log", { level, message });
});

let telegramBot: TelegramBot | null = null;
let streamHandler: AgentStreamHandler | null = null;

function log(level: string, msg: string): void {
  process.stderr.write(`[telegram-plugin][${level}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Host → Plugin: initialize
// ---------------------------------------------------------------------------

transport.onRequest("initialize", async (params) => {
  const { config, hostVersion } = params as unknown as InitializeParams;
  const cfg = config as TelegramConfig;

  log("info", `initialize hostVersion=${hostVersion}`);

  if (!cfg.bot_token) {
    throw new Error("bot_token is required in Telegram config");
  }

  // Create Telegram bot
  telegramBot = new TelegramBot(cfg, transport);
  const botInfo = await telegramBot.probe();
  log("info", `bot identity: @${botInfo.username} (${botInfo.id})`);

  // Create AgentStreamHandler
  streamHandler = new AgentStreamHandler(telegramBot, log);

  // Start long polling
  telegramBot.start();

  const result: InitializeResult = {
    protocolVersion: "0.2.0",
    capabilities: {
      streaming: true,
      interactiveCards: false,
      reactions: false,
      editMessage: true,
      media: false,
    },
    botInfo,
  };
  return result;
});

// ---------------------------------------------------------------------------
// Host → Plugin: agent event notifications (from SessionHub)
// ---------------------------------------------------------------------------

transport.onNotification("agent_start", (params) => {
  streamHandler?.onAgentStart(params);
});

transport.onNotification("agent_thinking", (params) => {
  streamHandler?.onAgentThinking(params);
});

transport.onNotification("agent_token", (params) => {
  streamHandler?.onAgentToken(params);
});

transport.onNotification("agent_text", (params) => {
  streamHandler?.onAgentText(params);
});

transport.onNotification("agent_tool_use", (params) => {
  streamHandler?.onAgentToolUse(params);
});

transport.onNotification("agent_tool_result", (params) => {
  streamHandler?.onAgentToolResult(params);
});

transport.onNotification("agent_end", (params) => {
  streamHandler?.onAgentEnd(params);
});

transport.onNotification("agent_error", (params) => {
  streamHandler?.onAgentError(params);
});

transport.onNotification("send_system_text", (params) => {
  streamHandler?.onSendSystemText(params);
});

// ---------------------------------------------------------------------------
// Host → Plugin: shutdown
// ---------------------------------------------------------------------------

transport.onRequest("shutdown", async () => {
  log("info", "shutdown requested");
  telegramBot?.stop();
  setTimeout(() => process.exit(0), 200);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------

transport.start();
log("info", "plugin started, waiting for initialize...");
