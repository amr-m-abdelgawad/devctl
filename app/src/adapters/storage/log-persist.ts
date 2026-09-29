import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from "node:fs";
import { join } from "node:path";
import { statfsSync } from "node:fs";
import { DEFAULT_LOG_CAP_BYTES, diskReserveBytes, SPILL_TOTAL_BYTES } from "../../domain/logs/budgets.ts";

const SPOOL_READ_BYTES = 256 * 1024;

type PendingLine = {
  key: string;
  line: string;
  bytes: number;
};

/**
 * Persists JSONL lines without ignoring stream backpressure. When the RAM
 * queue reaches its budget, further lines spill to a 0600 spool and are
 * written later. A full disk stops persistence and counts the loss; callers
 * keep the live ring.
 */
export class SessionLogWriter {
  private readonly streams = new Map<string, WriteStream>();
  private queue: PendingLine[] = [];
  private pending = 0;
  private blocked = false;
  private pumping = false;
  private readonly waiters: Array<() => void> = [];
  private spoolOffset = 0;
  private spoolRemainder = "";
  loss = 0;
  paused = false;
  private sessionBytes = 0;
  private diskOk = true;
  private writesSinceDiskCheck = 0;
  private readonly maxSessionBytes: number;
  private readonly maxSpoolBytes: number;

  constructor(
    private readonly directory: string,
    private readonly pendingLimit = SPILL_TOTAL_BYTES,
    caps?: { maxSessionBytes?: number; maxSpoolBytes?: number },
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.maxSessionBytes = caps?.maxSessionBytes && caps.maxSessionBytes > 0 ? caps.maxSessionBytes : DEFAULT_LOG_CAP_BYTES;
    this.maxSpoolBytes = caps?.maxSpoolBytes && caps.maxSpoolBytes > 0 ? caps.maxSpoolBytes : DEFAULT_LOG_CAP_BYTES;
    this.sessionBytes = jsonlBytes(directory);
  }

  sessionByteCount(): number {
    return this.sessionBytes;
  }

  pendingBytes(): number {
    return this.pending + this.spoolPending();
  }

  write(key: string, line: string): void {
    const bytes = Buffer.byteLength(line);
    if (this.paused || !this.roomFor(bytes)) {
      this.loss += 1;
      this.paused = true;
      return;
    }
    if (this.pending + bytes > this.pendingLimit) {
      if (!this.spill(key, line)) {
        this.loss += 1;
        this.paused = true;
        return;
      }
      this.sessionBytes += bytes;
      return;
    }
    this.queue.push({ key, line, bytes });
    this.pending += bytes;
    this.sessionBytes += bytes;
    this.pump();
  }

  async flush(): Promise<void> {
    if (this.idle()) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      this.pump();
    });
  }

  async close(): Promise<void> {
    await this.flush();
    await Promise.all(
      [...this.streams.values()].map(
        (stream) =>
          new Promise<void>((resolve) => {
            stream.end(() => resolve());
          }),
      ),
    );
    this.streams.clear();
  }

  private idle(): boolean {
    return this.queue.length === 0 && !this.blocked && !this.pumping && this.spoolPending() === 0;
  }

  private roomFor(bytes: number): boolean {
    if (this.sessionBytes + bytes > this.maxSessionBytes) {
      return false;
    }
    return this.diskAllows();
  }

  private diskAllows(): boolean {
    this.writesSinceDiskCheck += 1;
    if (this.writesSinceDiskCheck % 64 !== 1 && this.diskOk) {
      return this.diskOk;
    }
    this.diskOk = volumeHasReserve(this.directory);
    return this.diskOk;
  }

  private spill(key: string, line: string): boolean {
    const row = `${JSON.stringify({ key, line })}\n`;
    if (this.spoolPending() + Buffer.byteLength(row) > this.maxSpoolBytes) {
      return false;
    }
    try {
      appendFileSync(this.spoolPath(), row, { mode: 0o600 });
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code !== "ENOSPC" && code !== "EDQUOT";
    }
  }

  private spoolPending(): number {
    try {
      return Math.max(0, statSync(this.spoolPath()).size - this.spoolOffset);
    } catch {
      return 0;
    }
  }

  private pullSpool(): void {
    if (this.pending >= this.pendingLimit / 2 || !existsSync(this.spoolPath())) {
      return;
    }
    const path = this.spoolPath();
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const buf = Buffer.alloc(SPOOL_READ_BYTES);
      const read = readSync(fd, buf, 0, buf.length, this.spoolOffset);
      if (read <= 0) {
        unlinkSync(path);
        this.spoolOffset = 0;
        this.spoolRemainder = "";
        return;
      }
      this.spoolOffset += read;
      this.spoolRemainder += buf.subarray(0, read).toString("utf8");
      const rows = this.spoolRemainder.split("\n");
      this.spoolRemainder = rows.pop() ?? "";
      for (const row of rows) {
        const parsed = row === "" ? undefined : parseSpoolRow(row);
        if (parsed) {
          this.queue.push(parsed);
          this.pending += parsed.bytes;
        }
      }
      if (this.spoolOffset >= statSync(path).size && this.spoolRemainder === "") {
        unlinkSync(path);
        this.spoolOffset = 0;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.spoolOffset = 0;
      }
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
  }

  private pump(): void {
    if (this.blocked || this.pumping) {
      return;
    }
    const item = this.queue[0];
    if (item === undefined) {
      this.refillFromSpool();
    }
    const next = this.queue[0];
    if (next === undefined) {
      this.settle();
      return;
    }
    this.pumping = true;
    const stream = this.streamFor(next.key);
    let finished = false;
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      this.pumping = false;
      this.queue.shift();
      this.pending = Math.max(0, this.pending - next.bytes);
      if (!this.blocked) {
        setImmediate(() => {
          this.pump();
        });
      }
    };
    try {
      const accepted = stream.write(next.line, finish);
      if (!accepted) {
        this.blocked = true;
        stream.once("drain", () => {
          this.blocked = false;
          this.pump();
        });
      }
    } catch {
      this.loss += 1;
      this.paused = true;
      finish();
    }
  }

  private refillFromSpool(): void {
    let guard = 0;
    while (this.queue.length === 0 && this.spoolPending() > 0 && guard < 64) {
      const before = this.spoolOffset;
      this.pullSpool();
      guard += 1;
      if (this.spoolOffset === before) {
        return;
      }
    }
  }

  private settle(): void {
    if (!this.idle()) {
      return;
    }
    const waiting = this.waiters.splice(0, this.waiters.length);
    for (const resolve of waiting) {
      resolve();
    }
  }

  private streamFor(key: string): WriteStream {
    const existing = this.streams.get(key);
    if (existing) {
      return existing;
    }
    const stream = createWriteStream(join(this.directory, `${key}.jsonl`), { flags: "a", mode: 0o600 });
    stream.on("error", () => {
      this.loss += 1;
      this.paused = true;
    });
    this.streams.set(key, stream);
    return stream;
  }

  private spoolPath(): string {
    return join(this.directory, ".persist-spool");
  }
}

function jsonlBytes(directory: string): number {
  try {
    let total = 0;
    for (const name of readdirNames(directory)) {
      if (name.endsWith(".jsonl") || name === ".persist-spool") {
        total += statSync(join(directory, name)).size;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

function readdirNames(directory: string): string[] {
  return readdirSync(directory);
}

function volumeHasReserve(directory: string): boolean {
  if (process.platform === "win32") {
    return true;
  }
  try {
    const stats = statfsSync(directory);
    const free = stats.bavail * stats.bsize;
    const total = stats.blocks * stats.bsize;
    return free > diskReserveBytes(total);
  } catch {
    return true;
  }
}

function parseSpoolRow(row: string): PendingLine | undefined {
  try {
    const value: unknown = JSON.parse(row);
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const key = (value as { key?: unknown }).key;
    const line = (value as { line?: unknown }).line;
    if (typeof key !== "string" || typeof line !== "string") {
      return undefined;
    }
    return { key, line, bytes: Buffer.byteLength(line) };
  } catch {
    return undefined;
  }
}
