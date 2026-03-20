# VibeAround Telegram Plugin

Telegram 频道插件，通过 stdio JSON-RPC 2.0 与 VibeAround Host 通信。

## 架构

```
Telegram 用户 ←→ Long Polling (grammY) ←→ Plugin (Node.js) ←→ stdio JSON-RPC ←→ Rust Host
```

Plugin 作为 Host 的子进程运行，通过 stdin/stdout 交换 JSON-RPC 消息：
- Host → Plugin：`initialize`、`send_text`、`agent_start`、`agent_token`、`agent_end` 等
- Plugin → Host：`on_message`、`on_callback` 通知

## 功能

- 原生 `sendMessageDraft` 流式输出（Bot API 9.5）— 无需反复 `editMessageText`，无闪烁
- 基于 [grammY](https://grammy.dev/) + [@grammyjs/stream](https://github.com/grammyjs/stream)
- 自动重试限流请求（[@grammyjs/auto-retry](https://grammy.dev/plugins/auto-retry)）
- Long polling 模式（无需公网 URL）
- 超过 4096 字符自动分段发送
- Callback query（内联键盘）支持
- 私聊和群聊支持

## 项目结构

```
src/
├── main.ts              # 入口，JSON-RPC 路由
├── stdio.ts             # JSON-RPC 2.0 transport
├── stdout-guard.ts      # stdout 拦截器（保护 JSON-RPC 通道）
├── protocol.ts          # Host ↔ Plugin 协议类型定义
├── bot.ts               # grammY bot + long polling + 消息监听
└── agent-stream.ts      # Agent 事件 → sendMessageDraft 流式输出
```

## 开发

```bash
npm install
npm run build

# 监听模式开发
npm run dev
```

## 配置

在 VibeAround 的 `settings.json` 中配置：

```json
{
  "channels": {
    "telegram": {
      "bot_token": "123456:ABC-DEF..."
    }
  }
}
```

### Telegram Bot 创建步骤

1. 在 Telegram 中找到 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot`，按提示创建 bot
3. 将获得的 bot token 填入 `settings.json`
4. 可选：使用 `/setcommands` 注册斜杠命令（如 `/new`、`/status`、`/help`）

## 协议

JSON-RPC 2.0 over stdio，换行分隔。详见 `src/protocol.ts`。

## 流式输出

Agent 输出通过原生 `sendMessageDraft` API（Bot API 9.5，2026年3月）流式推送到 Telegram。相比反复调用 `editMessageText`，原生 draft 动画更流畅，无闪烁，无限流压力。[@grammyjs/stream](https://github.com/grammyjs/stream) 插件自动处理批量发送、消息分段和限流重试。
