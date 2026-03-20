/**
 * stdout-guard.ts — MUST be the first import in main.ts.
 *
 * 1. Intercepts process.stdout.write so that only JSON lines (starting with '{')
 *    pass through. Everything else is redirected to stderr.
 * 2. Redirects all console.* methods to stderr with proper object serialization.
 * 3. Provides plugLog() — sends structured log via JSON-RPC "plugin_log"
 *    notification when a transport is attached, falls back to stderr otherwise.
 */

import { inspect } from "node:util";

const _origWrite = process.stdout.write.bind(process.stdout);

process.stdout.write = function (chunk: any, ..._args: any[]): boolean {
  const str = typeof chunk === "string" ? chunk : chunk.toString();
  for (const line of str.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("{")) {
      _origWrite(line + "\n");
    } else {
      process.stderr.write("[stdout-guard] " + line + "\n");
    }
  }
  return true;
} as any;

function serialize(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return inspect(v, { depth: 3, colors: false, maxStringLength: 2000 });
  }
}

type LogSink = (level: string, message: string) => void;
let _logSink: LogSink | null = null;

export function setLogSink(sink: LogSink): void {
  _logSink = sink;
}

export function plugLog(level: string, message: string): void {
  if (_logSink) {
    _logSink(level, message);
  }
  process.stderr.write(`[telegram-plugin][${level}] ${message}\n`);
}

console.log = (...args: unknown[]) => { process.stderr.write(args.map(serialize).join(" ") + "\n"); };
console.info = console.log;
console.warn = (...args: unknown[]) => {
  const msg = args.map(serialize).join(" ");
  process.stderr.write(`[warn] ${msg}\n`);
  _logSink?.("warn", msg);
};
console.debug = (...args: unknown[]) => { process.stderr.write("[debug] " + args.map(serialize).join(" ") + "\n"); };
console.error = (...args: unknown[]) => {
  const msg = args.map(serialize).join(" ");
  process.stderr.write(`[error] ${msg}\n`);
  _logSink?.("error", msg);
};
