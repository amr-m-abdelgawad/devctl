import { Command } from "commander";

const STDOUT_CLOSED_CODES = new Set([
  "EPIPE",
  "EOF",
  "ECONNRESET",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);
const WIN_ERROR_BROKEN_PIPE = 109;
const WIN_WSAECONNRESET = 10054;
const UV_EOF = -4047;

export function configFlag(cmd: Command): string {
  const opts = cmd.optsWithGlobals() as { config?: string };
  return opts.config ?? "";
}

export function isStdoutClosed(err: unknown): boolean {
  if (err === null || typeof err !== "object") {
    return false;
  }
  const rec = err as NodeJS.ErrnoException;
  if (typeof rec.code === "string" && STDOUT_CLOSED_CODES.has(rec.code)) {
    return true;
  }
  if (rec.errno === WIN_ERROR_BROKEN_PIPE || rec.errno === WIN_WSAECONNRESET || rec.errno === UV_EOF) {
    return true;
  }
  const message = typeof rec.message === "string" ? rec.message.toLowerCase() : "";
  return message.includes("broken pipe") || message.includes("epipe");
}

export function writeOut(text: string): void {
  try {
    process.stdout.write(text);
  } catch (err) {
    if (isStdoutClosed(err)) {
      process.exit(0);
    }
    throw err;
  }
}
