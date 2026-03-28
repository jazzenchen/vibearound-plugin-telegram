/**
 * AgentStreamHandler — receives ACP session updates and renders them as
 * separate Telegram messages, one per contiguous variant block.
 *
 * Each contiguous run of the same variant (thinking, tool, text) becomes
 * one Telegram message. The current (unsealed) block streams in-place via
 * editMessageText. When the variant changes, the block is sealed (no more
 * edits) and a new message is created for the next block.
 */

import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { TelegramBot } from "./bot.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BlockKind = "thinking" | "tool" | "text";

interface MessageBlock {
  kind: BlockKind;
  content: string;
  /** Telegram message_id (set after first send). */
  messageId: number | null;
  /** Whether this block has been sealed (no more edits). */
  sealed: boolean;
}

interface ChannelState {
  blocks: MessageBlock[];
  chatId: number;
  /** Flush timer handle. */
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Timestamp of last edit (for throttling). */
  lastEditMs: number;
}

type LogFn = (level: string, msg: string) => void;

/** Minimum interval between message edits (ms). Telegram rate limit. */
const MIN_EDIT_INTERVAL_MS = 1000;

/** Flush interval for batching deltas (ms). */
const FLUSH_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// AgentStreamHandler
// ---------------------------------------------------------------------------

export interface VerboseConfig {
  showThinking: boolean;
  showToolUse: boolean;
}

export class AgentStreamHandler {
  private telegramBot: TelegramBot;
  private log: LogFn;
  private verbose: VerboseConfig;
  private channels = new Map<string, ChannelState>();
  private lastSessionId: string | null = null;

  constructor(telegramBot: TelegramBot, log: LogFn, verbose?: Partial<VerboseConfig>) {
    this.telegramBot = telegramBot;
    this.log = log;
    this.verbose = {
      showThinking: verbose?.showThinking ?? false,
      showToolUse: verbose?.showToolUse ?? false,
    };
  }

  /** Called when a prompt is sent — init state. */
  onPromptSent(sessionId: string): void {
    this.lastSessionId = sessionId;
    const chatId = parseInt(sessionId, 10);
    if (isNaN(chatId)) return;

    // Clean up old state
    const old = this.channels.get(sessionId);
    if (old?.flushTimer) clearTimeout(old.flushTimer);
    this.channels.delete(sessionId);

    this.channels.set(sessionId, {
      blocks: [],
      chatId,
      flushTimer: null,
      lastEditMs: 0,
    });
  }

  /** Agent initialized — send info message. */
  onAgentReady(agent: string, version: string): void {
    const chatId = this.lastSessionId ? parseInt(this.lastSessionId, 10) : null;
    if (chatId && !isNaN(chatId)) {
      this.telegramBot.bot.api.sendMessage(chatId, `🤖 Agent: ${agent} v${version}`).catch(() => {});
    }
  }

  /** Session ready — send session info. */
  onSessionReady(sessionId: string): void {
    const chatId = this.lastSessionId ? parseInt(this.lastSessionId, 10) : null;
    if (chatId && !isNaN(chatId)) {
      this.telegramBot.bot.api.sendMessage(chatId, `📋 Session: ${sessionId}`).catch(() => {});
    }
  }

  /** Handle system text from host. */
  onSystemText(text: string): void {
    const chatId = this.lastSessionId ? parseInt(this.lastSessionId, 10) : null;
    if (chatId && !isNaN(chatId)) {
      this.telegramBot.bot.api.sendMessage(chatId, text).catch(() => {});
    }
  }

  // ---- ACP SessionUpdate dispatcher ----

  onSessionUpdate(notification: SessionNotification): void {
    const sessionId = notification.sessionId;
    const update = notification.update;
    const variant = (update as any).sessionUpdate as string;

    switch (variant) {
      case "agent_message_chunk": {
        const content = (update as any).content as { text?: string } | undefined;
        const delta = content?.text ?? "";
        if (delta) this.appendToBlock(sessionId, "text", delta);
        break;
      }
      case "agent_thought_chunk": {
        if (!this.verbose.showThinking) return;
        const content = (update as any).content as { text?: string } | undefined;
        const delta = content?.text ?? "";
        if (delta) this.appendToBlock(sessionId, "thinking", delta);
        break;
      }
      case "tool_call": {
        if (!this.verbose.showToolUse) return;
        // ACP ToolCall: { toolCallId, title, kind, status, ... }
        const toolTitle = (update as any).title as string | undefined;
        if (toolTitle) this.appendToBlock(sessionId, "tool", `🔧 ${toolTitle}\n`);
        break;
      }
      case "tool_call_update": {
        if (!this.verbose.showToolUse) return;
        const title = (update as any).title as string | undefined;
        const status = (update as any).status as string | undefined;
        const label = title ?? "tool";
        if (status === "completed" || status === "error") {
          this.appendToBlock(sessionId, "tool", `✅ ${label}\n`);
        }
        break;
      }
      default:
        this.log("debug", `unhandled session update variant: ${variant}`);
    }
  }

  // ---- Turn lifecycle (called from bot.ts after prompt() returns) ----

  /** Called when prompt() returns — seal last block. */
  onTurnComplete(sessionId: string): void {
    const state = this.channels.get(sessionId);
    if (!state) return;

    this.log("debug", `turn_complete session=${sessionId} blocks=${state.blocks.length}`);

    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }

    // Seal and flush last block
    const last = state.blocks[state.blocks.length - 1];
    if (last && !last.sealed) {
      last.sealed = true;
      this.flushBlock(state, last);
    }

    this.channels.delete(sessionId);
  }

  /** Called on prompt error. */
  onError(sessionId: string, errorText: string): void {
    this.log("error", `error session=${sessionId}: ${errorText}`);

    const state = this.channels.get(sessionId);
    if (state?.flushTimer) clearTimeout(state.flushTimer);

    const chatId = state?.chatId ?? parseInt(sessionId, 10);
    if (!isNaN(chatId)) {
      this.telegramBot.bot.api.sendMessage(chatId, `❌ Error: ${errorText}`).catch(() => {});
    }

    this.channels.delete(sessionId);
  }

  // ---- Block management ----

  private appendToBlock(sessionId: string, kind: BlockKind, delta: string): void {
    const state = this.channels.get(sessionId);
    if (!state) return;

    const current = state.blocks.length > 0
      ? state.blocks[state.blocks.length - 1]
      : null;

    if (current && !current.sealed && current.kind === kind) {
      current.content += delta;
    } else {
      // Seal current block
      if (current && !current.sealed) {
        current.sealed = true;
        this.flushBlock(state, current);
      }
      state.blocks.push({ kind, content: delta, messageId: null, sealed: false });
    }

    this.scheduleFlush(sessionId);
  }

  private scheduleFlush(sessionId: string): void {
    const state = this.channels.get(sessionId);
    if (!state || state.flushTimer) return;

    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      this.flush(sessionId);
    }, FLUSH_INTERVAL_MS);
  }

  private flush(sessionId: string): void {
    const state = this.channels.get(sessionId);
    if (!state) return;

    const block = state.blocks.length > 0
      ? state.blocks[state.blocks.length - 1]
      : null;
    if (!block || block.sealed || !block.content) return;

    const now = Date.now();
    if (now - state.lastEditMs < MIN_EDIT_INTERVAL_MS) {
      this.scheduleFlush(sessionId);
      return;
    }

    this.flushBlock(state, block);
  }

  private async flushBlock(state: ChannelState, block: MessageBlock): Promise<void> {
    const text = this.formatBlock(block);
    if (!text) return;

    try {
      if (!block.messageId) {
        block.messageId = -1; // sentinel to prevent concurrent creates
        const msg = await this.telegramBot.bot.api.sendMessage(state.chatId, text);
        block.messageId = msg.message_id;
        state.lastEditMs = Date.now();
      } else if (block.messageId > 0) {
        await this.telegramBot.bot.api.editMessageText(state.chatId, block.messageId, text);
        state.lastEditMs = Date.now();
      }
    } catch (e) {
      this.log("error", `flushBlock failed: ${e}`);
    }
  }

  private formatBlock(block: MessageBlock): string {
    switch (block.kind) {
      case "thinking":
        return `💭 ${block.content}`;
      case "tool":
        return block.content.trim();
      case "text":
        return block.content;
    }
  }
}
