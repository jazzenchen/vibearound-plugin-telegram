/**
 * TelegramBot — grammY bot wrapper.
 *
 * Handles:
 *   - Bot creation and long-polling lifecycle
 *   - Inbound message parsing → ACP prompt() to Host
 *   - Callback query handling → ACP extNotification to Host
 */

import { Bot, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import type { Agent } from "@agentclientprotocol/sdk";
import type { AgentStreamHandler } from "./agent-stream.js";

export interface TelegramConfig {
  bot_token: string;
}

export type BotContext = Context;
type LogFn = (level: string, msg: string) => void;

export class TelegramBot {
  readonly bot: Bot<BotContext>;
  private agent: Agent;
  private log: LogFn;
  private streamHandler: AgentStreamHandler | null = null;

  constructor(config: TelegramConfig, agent: Agent, log: LogFn) {
    this.agent = agent;
    this.log = log;
    this.bot = new Bot<BotContext>(config.bot_token);

    // Install auto-retry (handles rate limits)
    this.bot.api.config.use(autoRetry());

    this.registerHandlers();
  }

  /** Probe bot identity (getMe). */
  async probe(): Promise<{ id: number; username: string; firstName: string }> {
    const me = await this.bot.api.getMe();
    return { id: me.id, username: me.username, firstName: me.first_name };
  }

  /** Start long-polling. */
  start(): void {
    this.bot.start({
      onStart: () => {
        this.log("info", "bot started (long polling)");
      },
    });
  }

  /** Stop the bot gracefully. */
  stop(): void {
    this.bot.stop();
  }

  setStreamHandler(handler: AgentStreamHandler): void {
    this.streamHandler = handler;
  }

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  private registerHandlers(): void {
    this.bot.on("message:text", (ctx) => {
      this.handleTextMessage(ctx);
    });

    this.bot.on("callback_query:data", (ctx) => {
      this.handleCallbackQuery(ctx);
    });

    this.bot.catch((err) => {
      this.log("error", `bot error: ${err.message}`);
    });
  }

  private async handleTextMessage(ctx: Context): Promise<void> {
    const msg = ctx.message;
    if (!msg || !msg.text) return;

    const chat = msg.chat;
    const from = msg.from;
    if (!from) return;

    // Use chat_id as ACP sessionId
    const chatId = String(chat.id);

    this.log("debug", `message chat=${chatId} text=${msg.text.slice(0, 80)}`);

    // Notify stream handler before prompt
    this.streamHandler?.onPromptSent(chatId);

    // Show typing indicator — resend every 4s (Telegram expires it after ~5s)
    await this.bot.api.sendChatAction(chat.id, "typing").catch(() => {});
    const typingInterval = setInterval(() => {
      this.bot.api.sendChatAction(chat.id, "typing").catch(() => {});
    }, 4000);

    // Send as ACP prompt — blocks until turn completes, returns real StopReason.
    // Session notifications stream in during the call.
    try {
      const response = await this.agent.prompt({
        sessionId: chatId,
        prompt: [{ type: "text", text: msg.text }],
      });
      this.log("info", `prompt done chat=${chatId} stopReason=${response.stopReason}`);
      this.streamHandler?.onTurnComplete(chatId);
    } catch (error: unknown) {
      this.log("error", `prompt failed chat=${chatId}: ${error}`);
      this.streamHandler?.onError(chatId, String(error));
    } finally {
      clearInterval(typingInterval);
    }
  }

  private handleCallbackQuery(ctx: Context): void {
    const query = ctx.callbackQuery;
    if (!query || !query.data) return;

    const from = query.from;
    const chatId = query.message?.chat?.id;
    if (!chatId) return;

    // Send as ACP extension notification
    this.agent
      .extNotification?.("channel/callback", {
        channelId: `telegram:${chatId}`,
        callbackId: query.id,
        sender: {
          id: String(from.id),
          name: [from.first_name, from.last_name].filter(Boolean).join(" "),
          username: from.username,
        },
        data: query.data,
        messageId: query.message
          ? String(query.message.message_id)
          : undefined,
      })
      .catch(() => {});

    // Acknowledge the callback query
    ctx.answerCallbackQuery().catch(() => {});
  }
}
