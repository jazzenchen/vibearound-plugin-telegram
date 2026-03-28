#!/usr/bin/env node
/**
 * VibeAround Telegram Plugin — ACP Client
 *
 * Spawned by the Rust host as a child process.
 * Communicates via ACP protocol (JSON-RPC 2.0 over stdio).
 *
 * Plugin = ACP Client, Host = ACP Agent.
 * Plugin sends prompt() with chatId as sessionId.
 * Host streams back via sessionUpdate notifications.
 */

import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

import { TelegramBot } from "./bot.js";
import { AgentStreamHandler } from "./agent-stream.js";

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

let agent: Agent | null = null;
let telegramBot: TelegramBot | null = null;
let streamHandler: AgentStreamHandler | null = null;

function log(level: string, msg: string): void {
  process.stderr.write(`[telegram-plugin][${level}] ${msg}\n`);
}

// Redirect console to stderr (keep stdout clean for ACP JSON-RPC)
console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(" ") + "\n");
console.info = console.log;
console.warn = (...args: unknown[]) => process.stderr.write(`[warn] ${args.map(String).join(" ")}\n`);
console.error = (...args: unknown[]) => process.stderr.write(`[error] ${args.map(String).join(" ")}\n`);
console.debug = (...args: unknown[]) => process.stderr.write(`[debug] ${args.map(String).join(" ")}\n`);

// ---------------------------------------------------------------------------
// ACP Client implementation — receives events from host
// ---------------------------------------------------------------------------

const client: (agent: Agent) => Client = (a) => {
  agent = a;

  return {
    async sessionUpdate(params: SessionNotification): Promise<void> {
      streamHandler?.onSessionUpdate(params);
    },

    async requestPermission(
      params: RequestPermissionRequest
    ): Promise<RequestPermissionResponse> {
      const first = params.options?.[0];
      if (first) {
        return {
          outcome: {
            outcome: "selected",
            optionId: first.optionId,
          },
        } as RequestPermissionResponse;
      }
      throw new Error("No permission options provided");
    },

    async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
      // ACP SDK prepends "_" to ext methods — normalize
      const normalizedMethod = method.startsWith("_") ? method.slice(1) : method;
      switch (normalizedMethod) {
        case "channel/system_text": {
          const text = params.text as string;
          streamHandler?.onSystemText(text);
          break;
        }
        case "channel/agent_ready": {
          const agentName = params.agent as string;
          const version = params.version as string;
          log("info", `agent_ready: ${agentName} v${version}`);
          streamHandler?.onAgentReady(agentName, version);
          break;
        }
        case "channel/session_ready": {
          const sessionId = params.sessionId as string;
          log("info", `session_ready: ${sessionId}`);
          streamHandler?.onSessionReady(sessionId);
          break;
        }
        default:
          log("warn", `unhandled ext_notification: ${method}`);
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Create ACP connection via stdio
// ---------------------------------------------------------------------------

// Convert Node.js streams to Web Streams for ndJsonStream
const inputStream = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const outputStream = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const stream = ndJsonStream(outputStream, inputStream);
const conn = new ClientSideConnection(client, stream);

// ---------------------------------------------------------------------------
// Initialize — get channel config from host
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  log("info", "initializing ACP connection...");

  const initResponse = await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: {
      name: "vibearound-telegram",
      version: "0.1.0",
    },
    capabilities: {},
  });

  // Extract channel config from _meta
  const meta = (initResponse as any)._meta as Record<string, unknown> | undefined;
  const config = (meta?.config ?? {}) as Record<string, unknown>;
  const botToken = config.bot_token as string;

  if (!botToken) {
    throw new Error("bot_token is required in Telegram config");
  }

  log("info", `initialized, host=${initResponse.agentInfo?.name ?? "unknown"}`);

  // Create Telegram bot — pass agent reference for sending prompts
  telegramBot = new TelegramBot({ bot_token: botToken }, agent!, log);
  const botInfo = await telegramBot.probe();
  log("info", `bot identity: @${botInfo.username} (${botInfo.id})`);

  // Parse verbose config
  const verbose = (config as any).verbose as { show_thinking?: boolean; show_tool_use?: boolean } | undefined;

  // Create AgentStreamHandler
  streamHandler = new AgentStreamHandler(telegramBot, log, {
    showThinking: verbose?.show_thinking ?? false,
    showToolUse: verbose?.show_tool_use ?? false,
  });
  telegramBot.setStreamHandler(streamHandler);

  // Start long polling
  telegramBot.start();
  log("info", "plugin started");

  // Wait for connection to close
  await conn.closed;
  log("info", "connection closed, shutting down");
  telegramBot.stop();
  process.exit(0);
}

start().catch((error) => {
  log("error", `fatal: ${error}`);
  process.exit(1);
});
