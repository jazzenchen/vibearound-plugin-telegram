/**
 * AgentStreamHandler — receives agent events from the Host and streams them
 * to Telegram using sendMessageDraft (native streaming).
 *
 * State machine per channel:
 *   idle → streaming (on agent_start)
 *   streaming → streaming (on agent_token / agent_thinking / agent_tool_use)
 *   streaming → idle (on agent_end / agent_error)
 *
 * Uses @grammyjs/stream's api.streamMessage under the hood. Agent tokens are
 * fed into an async generator that the stream plugin consumes, calling
 * sendMessageDraft automatically with proper batching and rate-limit handling.
 */

import { streamApi } from "@grammyjs/stream";
import type { TelegramBot } from "./bot.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChannelState {
  /** Accumulated text content from agent_token deltas. */
  text: string;
  /** Thinking text (latest). */
  thinking: string;
  /** Tool use status lines. */
  toolLines: string[];
  /** Numeric Telegram chat_id (extracted from channelId). */
  chatId: number;
  /** User's message_id (for reply_to). */
  userMessageId: number | null;
  /** Resolve function to push chunks into the async generator. */
  pushChunk: ((chunk: string) => void) | null;
  /** Resolve function to signal stream completion. */
  endStream: (() => void) | null;
  /** Promise for the streamMessage call. */
  streamPromise: Promise<void> | null;
  /** Whether we've started streaming. */
  started: boolean;
  /** AbortController for cancelling the stream. */
  abort: AbortController;
  /** Previous content length (to compute deltas). */
  prevContentLength: number;
}

type LogFn = (level: string, msg: string) => void;

// ---------------------------------------------------------------------------
// AgentStreamHandler
// ---------------------------------------------------------------------------

export class AgentStreamHandler {
  private telegramBot: TelegramBot;
  private log: LogFn;
  private channels = new Map<string, ChannelState>();
  private streamMessageFn: ReturnType<typeof streamApi>["streamMessage"];

  constructor(telegramBot: TelegramBot, log: LogFn) {
    this.telegramBot = telegramBot;
    this.log = log;
    // Build the streamMessage function from the raw API
    const { streamMessage } = streamApi(telegramBot.bot.api.raw);
    this.streamMessageFn = streamMessage;
  }

  // ---- Event handlers (called from main.ts notification registrations) ----

  onAgentStart(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const userMessageId = params.userMessageId as string | undefined;
    const chatId = this.parseChatId(channelId);

    this.log("debug", `agent_start channel=${channelId}`);

    const abort = new AbortController();

    // Create the async generator + push/end controls
    const { generator, push, end } = createAsyncQueue();

    const state: ChannelState = {
      text: "",
      thinking: "",
      toolLines: [],
      chatId,
      userMessageId: userMessageId ? parseInt(userMessageId, 10) : null,
      pushChunk: push,
      endStream: end,
      streamPromise: null,
      started: false,
      abort,
      prevContentLength: 0,
    };

    this.channels.set(channelId, state);

    // Start the streaming pipeline — streamMessage consumes the generator
    // and calls sendMessageDraft / sendMessage automatically.
    const draftIdOffset = Date.now() & 0x7fffffff; // unique per stream
    state.streamPromise = this.streamMessageFn(
        chatId,
        draftIdOffset,
        generator,
        // sendMessageDraft extra params (only parse_mode, entities, message_thread_id)
        undefined,
        // sendMessage extra params (supports reply_parameters)
        state.userMessageId
          ? { reply_parameters: { message_id: state.userMessageId } }
          : undefined,
        abort.signal as any,
      )
      .then(() => {
        this.log("debug", `streamMessage completed channel=${channelId}`);
      })
      .catch((e: unknown) => {
        this.log("error", `streamMessage error: ${e}`);
      });

    state.started = true;
  }

  onAgentThinking(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const text = params.text as string;
    const state = this.channels.get(channelId);
    if (!state) return;

    state.thinking = text;
    this.pushDelta(channelId, state);
  }

  onAgentToken(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const delta = params.delta as string;
    const state = this.channels.get(channelId);
    if (!state) return;

    state.text += delta;
    this.pushDelta(channelId, state);
  }

  onAgentText(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const text = params.text as string;

    // agent_text is a complete text block (e.g. command response)
    // Send as a simple message
    const chatId = this.parseChatId(channelId);
    this.telegramBot.bot.api.sendMessage(chatId, text).catch((e) => {
      this.log("error", `sendMessage failed: ${e}`);
    });
  }

  onAgentToolUse(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const tool = params.tool as string;
    const state = this.channels.get(channelId);
    if (!state) return;

    state.toolLines.push(`🔧 ${tool}`);
    this.pushDelta(channelId, state);
  }

  onAgentToolResult(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const tool = params.tool as string;
    this.log("debug", `agent_tool_result channel=${channelId} tool=${tool}`);
  }

  onAgentEnd(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const state = this.channels.get(channelId);
    if (!state) return;

    this.log("debug", `agent_end channel=${channelId} textLen=${state.text.length}`);

    // Push any remaining content as final delta
    this.pushDelta(channelId, state);

    // Signal end of stream — this causes streamMessage to send the final sendMessage
    state.endStream?.();
    state.pushChunk = null;
    state.endStream = null;

    // Cleanup after stream completes
    state.streamPromise?.finally(() => {
      this.channels.delete(channelId);
    });
  }

  onAgentError(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const error = params.error as string;
    const state = this.channels.get(channelId);

    this.log("error", `agent_error channel=${channelId} error=${error}`);

    if (state) {
      // Push error message into the stream, then end it
      state.pushChunk?.(`\n\n❌ Error: ${error}`);
      state.endStream?.();
      state.pushChunk = null;
      state.endStream = null;

      state.streamPromise?.finally(() => {
        this.channels.delete(channelId);
      });
    } else {
      // No active stream — send error as a standalone message
      const chatId = this.parseChatId(channelId);
      this.telegramBot.bot.api
        .sendMessage(chatId, `❌ Error: ${error}`)
        .catch(() => {});
    }
  }

  onSendSystemText(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const text = params.text as string;
    const replyTo = params.replyTo as string | undefined;

    const chatId = this.parseChatId(channelId);
    const extra = replyTo
      ? { reply_parameters: { message_id: parseInt(replyTo, 10) } }
      : undefined;

    this.telegramBot.bot.api.sendMessage(chatId, text, extra).catch((e) => {
      this.log("error", `sendMessage failed: ${e}`);
    });
  }

  // ---- Internal ----

  /**
   * Build the full content string and push only the new delta into the stream.
   * The stream plugin accumulates all chunks, so we only send what's new.
   */
  private pushDelta(channelId: string, state: ChannelState): void {
    const content = this.buildContent(state);
    if (!content) return;

    const newPart = content.slice(state.prevContentLength);
    if (newPart && state.pushChunk) {
      state.pushChunk(newPart);
      state.prevContentLength = content.length;
    }
  }

  private buildContent(state: ChannelState): string {
    const parts: string[] = [];

    // Thinking indicator
    if (state.thinking && !state.text) {
      parts.push(`💭 ${state.thinking}`);
    }

    // Tool use lines
    if (state.toolLines.length > 0) {
      parts.push(state.toolLines.join("\n"));
    }

    // Main text
    if (state.text) {
      parts.push(state.text);
    }

    return parts.join("\n\n");
  }

  /** Extract numeric chat_id from channelId (e.g. "telegram:12345" → 12345). */
  private parseChatId(channelId: string): number {
    const idx = channelId.indexOf(":");
    const raw = idx >= 0 ? channelId.slice(idx + 1) : channelId;
    return parseInt(raw, 10);
  }
}

// ---------------------------------------------------------------------------
// Async queue helper — creates an async generator with external push/end
// ---------------------------------------------------------------------------

function createAsyncQueue(): {
  generator: AsyncGenerator<string, void, unknown>;
  push: (chunk: string) => void;
  end: () => void;
} {
  let resolve: ((value: IteratorResult<string>) => void) | null = null;
  const buffer: string[] = [];
  let done = false;

  function push(chunk: string): void {
    if (done) return;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r({ value: chunk, done: false });
    } else {
      buffer.push(chunk);
    }
  }

  function end(): void {
    done = true;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r({ value: undefined as any, done: true });
    }
  }

  async function* generator(): AsyncGenerator<string, void, unknown> {
    while (true) {
      if (buffer.length > 0) {
        yield buffer.shift()!;
      } else if (done) {
        return;
      } else {
        const result = await new Promise<IteratorResult<string>>((r) => {
          resolve = r;
        });
        if (result.done) return;
        yield result.value;
      }
    }
  }

  return { generator: generator(), push, end };
}
