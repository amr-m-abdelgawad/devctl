import { stripAnsi } from "./ansi.ts";
import { severityFromPlainText } from "./parse.ts";
import { SeverityUnspecified } from "./severity.ts";
import type { LogIngest } from "./types.ts";

export const DEFAULT_MULTILINE_MAX_WAIT_MS = 80;
export const DEFAULT_MULTILINE_MAX_LINES = 200;

export const TRACEBACK_START = /^Traceback \(most recent call last\):/;
export const HTTP_STATUS_CONTINUATION = /^\s+\d{3}\s*$/;
const TRACEBACK_CAUSE =
  /^(?:The above exception was the direct cause of the following exception:|During handling of the above exception, another exception occurred:)\s*$/;
const INDENTED = /^\s+/;

export type MultilineOptions = {
  start?: string;
  continuation?: string;
  max_wait_ms?: number;
  max_lines?: number;
};

export type FoldedLog = {
  ingest: LogIngest;
  body: string;
  severityNumber: number;
  arrivedMs: number;
};

type ResolvedMultiline = {
  start?: RegExp;
  continuation?: RegExp;
  maxWaitMs: number;
  maxLines: number;
};

type ServiceBuffer = {
  first: LogIngest;
  lines: string[];
  firstAt: number;
  lastAt: number;
  inTraceback: boolean;
  sawTracebackException: boolean;
  options: ResolvedMultiline;
};

export function isProcessLogSource(source: string): boolean {
  return source === "stdout" || source === "stderr";
}

export function resolveMultilineOptions(options?: MultilineOptions): ResolvedMultiline {
  return {
    start: compilePattern(options?.start),
    continuation: compilePattern(options?.continuation),
    maxWaitMs: options?.max_wait_ms !== undefined && options.max_wait_ms >= 0 ? options.max_wait_ms : DEFAULT_MULTILINE_MAX_WAIT_MS,
    maxLines: options?.max_lines !== undefined && options.max_lines > 0 ? options.max_lines : DEFAULT_MULTILINE_MAX_LINES,
  };
}

function compilePattern(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined || pattern === "") {
    return undefined;
  }
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

export class MultilineAssembler {
  private readonly buffers = new Map<string, ServiceBuffer>();

  push(ingest: LogIngest, nowMs: number, options?: MultilineOptions): FoldedLog[] {
    const emitted = this.flushDue(nowMs);
    const resolved = resolveMultilineOptions(options);
    const line = ingest.message ?? (typeof ingest.body === "string" ? ingest.body : "");
    const key = JSON.stringify([ingest.service, ingest.source, ingest.stream ?? "", ingest.pid, ingest.identity ?? ""]);
    const current = this.buffers.get(key);
    if (!current) {
      this.buffers.set(key, this.newBuffer(ingest, line, nowMs, resolved));
      return this.emitIfFull(key, emitted);
    }
    if (this.isContinuation(line, current, resolved)) {
      current.lines.push(line);
      current.lastAt = nowMs;
      current.options = resolved;
      this.noteTracebackProgress(current, line);
      return this.emitIfFull(key, emitted);
    }
    emitted.push(this.take(key)!);
    this.buffers.set(key, this.newBuffer(ingest, line, nowMs, resolved));
    return this.emitIfFull(key, emitted);
  }

  flushDue(nowMs: number): FoldedLog[] {
    const emitted: FoldedLog[] = [];
    for (const [key, buffer] of this.buffers) {
      if (nowMs - buffer.lastAt >= buffer.options.maxWaitMs) {
        emitted.push(this.take(key)!);
      }
    }
    return emitted;
  }

  flushAll(): FoldedLog[] {
    const emitted: FoldedLog[] = [];
    for (const key of [...this.buffers.keys()]) {
      emitted.push(this.take(key)!);
    }
    return emitted;
  }

  nextDeadlineMs(): number | undefined {
    let deadline: number | undefined;
    for (const buffer of this.buffers.values()) {
      const at = buffer.lastAt + buffer.options.maxWaitMs;
      if (deadline === undefined || at < deadline) {
        deadline = at;
      }
    }
    return deadline;
  }

  private newBuffer(ingest: LogIngest, line: string, nowMs: number, options: ResolvedMultiline): ServiceBuffer {
    return {
      first: ingest,
      lines: [line],
      firstAt: nowMs,
      lastAt: nowMs,
      inTraceback: TRACEBACK_START.test(line),
      sawTracebackException: false,
      options,
    };
  }

  private emitIfFull(key: string, emitted: FoldedLog[]): FoldedLog[] {
    const buffer = this.buffers.get(key);
    if (buffer && buffer.lines.length >= buffer.options.maxLines) {
      emitted.push(this.take(key)!);
    }
    return emitted;
  }

  private take(key: string): FoldedLog | undefined {
    const buffer = this.buffers.get(key);
    if (!buffer) {
      return undefined;
    }
    this.buffers.delete(key);
    const raw = buffer.lines.join("\n");
    const body = stripAnsi(raw);
    return {
      ingest: { ...buffer.first, message: raw, raw },
      body,
      severityNumber: severityFromFoldedLines(buffer.lines),
      arrivedMs: buffer.firstAt,
    };
  }

  private isContinuation(line: string, current: ServiceBuffer, options: ResolvedMultiline): boolean {
    if (HTTP_STATUS_CONTINUATION.test(line)) {
      return true;
    }
    if (current.inTraceback && this.isTracebackContinuation(line, current)) {
      return true;
    }
    if (options.start?.test(line)) {
      return false;
    }
    if (options.continuation?.test(line)) {
      return true;
    }
    return Boolean(options.start && !options.continuation);
  }

  private isTracebackContinuation(line: string, current: ServiceBuffer): boolean {
    if (TRACEBACK_START.test(line) || TRACEBACK_CAUSE.test(line)) {
      current.sawTracebackException = false;
      return true;
    }
    if (INDENTED.test(line)) {
      return true;
    }
    if (!current.sawTracebackException) {
      return true;
    }
    return false;
  }

  private noteTracebackProgress(current: ServiceBuffer, line: string): void {
    if (TRACEBACK_START.test(line)) {
      current.inTraceback = true;
      current.sawTracebackException = false;
      return;
    }
    if (TRACEBACK_CAUSE.test(line)) {
      current.inTraceback = true;
      current.sawTracebackException = false;
      return;
    }
    if (current.inTraceback && !INDENTED.test(line) && !HTTP_STATUS_CONTINUATION.test(line)) {
      current.sawTracebackException = true;
    }
  }
}

export function severityFromFoldedLines(lines: readonly string[]): number {
  for (const line of lines) {
    const level = severityFromPlainText(line);
    if (level !== SeverityUnspecified) {
      return level;
    }
  }
  return severityFromPlainText(lines.join("\n"));
}
