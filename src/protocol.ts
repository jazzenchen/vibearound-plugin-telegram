/**
 * VibeAround Telegram Plugin Protocol — Type definitions
 *
 * JSON-RPC 2.0 over stdio between Host (Rust) and Plugin (Node.js).
 */

// ============================================================================
// JSON-RPC 2.0 base
// ============================================================================

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ============================================================================
// Host → Plugin
// ============================================================================

export interface TelegramConfig {
  bot_token: string;
}

export interface InitializeParams {
  config: TelegramConfig;
  hostVersion: string;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: PluginCapabilities;
  botInfo?: { id: number; username: string; firstName: string };
}

export interface SendTextParams {
  channelId: string;
  text: string;
  replyTo?: string;
}

export interface EditMessageParams {
  channelId: string;
  messageId: string;
  text: string;
}

// ============================================================================
// Plugin → Host (notifications)
// ============================================================================

export interface OnMessageParams {
  channelId: string;
  messageId: string;
  chatType: "private" | "group" | "supergroup" | "channel";
  sender: SenderInfo;
  text: string;
  replyTo?: string;
}

export interface OnCallbackParams {
  channelId: string;
  callbackId: string;
  sender: SenderInfo;
  data: string;
  messageId?: string;
}

// ============================================================================
// Shared types
// ============================================================================

export interface SenderInfo {
  id: string;
  name?: string;
  username?: string;
  type?: "user" | "bot";
}

export interface PluginCapabilities {
  streaming: boolean;
  interactiveCards: boolean;
  reactions: boolean;
  editMessage: boolean;
  media: boolean;
}
