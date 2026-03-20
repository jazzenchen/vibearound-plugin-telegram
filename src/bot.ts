/**
 * TelegramBot — grammY bot wrapper.
 *
 * Handles:
 *   - Bot creation and long-polling lifecycle
 *   - Inbound message parsing → on_message notification to Host
 *   - Callback query handling → on_callback notification to Host
 */

import { Bot, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { stream, type StreamFlavor } from "@grammyjs/stream";
import type { StdioTransport } from "./stdio.js";
import type { TelegramConfig, OnMessageParams, SenderInfo } from "./protocol.js";

export type BotContext = StreamFlavor<Context>;

export class TelegramBot {
  readonly bot: Bot<BotContext>;
  private transport: StdioTransport;
  private config: TelegramConfig;

  constructor(config: TelegramConfig, transport: StdioTransport) {
    this.config = config;
    this.transport = transport;
    this.bot = new Bot<BotContext>(config.bot_token);

    // Install auto-retry before stream plugin (handles rate limits)
    this.bot.api.config.use(autoRetry());
    // Install stream plugin (adds replyWithStream / api.streamMessage)
    this.bot.use(stream());

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

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  private registerHandlers(): void {
    // Text messages
    this.bot.on("message:text", (ctx) => {
      this.handleTextMessage(ctx);
    });

    // Callback queries (inline keyboard buttons)
    this.bot.on("callback_query:data", (ctx) => {
      this.handleCallbackQuery(ctx);
    });

    // Error handler
    this.bot.catch((err) => {
      this.log("error", `bot error: ${err.message}`);
    });
  }

  private handleTextMessage(ctx: Context): void {
    const msg = ctx.message;
    if (!msg || !msg.text) return;

    const chat = msg.chat;
    const from = msg.from;
    if (!from) return;

    // Build channelId in the format Host expects: "telegram:{chat_id}"
    const channelId = `telegram:${chat.id}`;

    const sender: SenderInfo = {
      id: String(from.id),
      name: [from.first_name, from.last_name].filter(Boolean).join(" "),
      username: from.username,
      type: from.is_bot ? "bot" : "user",
    };

    const params: OnMessageParams = {
      channelId,
      messageId: String(msg.message_id),
      chatType: chat.type as OnMessageParams["chatType"],
      sender,
      text: msg.text,
      replyTo: msg.reply_to_message
        ? String(msg.reply_to_message.message_id)
        : undefined,
    };

    this.transport.notify("on_message", params as unknown as Record<string, unknown>);
    this.log("debug", `on_message chat=${chat.id} text=${msg.text.slice(0, 80)}`);
  }

  private handleCallbackQuery(ctx: Context): void {
    const query = ctx.callbackQuery;
    if (!query || !query.data) return;

    const from = query.from;
    const chatId = query.message?.chat?.id;
    if (!chatId) return;

    const channelId = `telegram:${chatId}`;

    const sender: SenderInfo = {
      id: String(from.id),
      name: [from.first_name, from.last_name].filter(Boolean).join(" "),
      username: from.username,
      type: "user",
    };

    this.transport.notify("on_callback", {
      channelId,
      callbackId: query.id,
      sender,
      data: query.data,
      messageId: query.message
        ? String(query.message.message_id)
        : undefined,
    } as unknown as Record<string, unknown>);

    // Acknowledge the callback query
    ctx.answerCallbackQuery().catch(() => {});
  }

  private log(level: string, msg: string): void {
    this.transport.log(level, msg);
  }
}
