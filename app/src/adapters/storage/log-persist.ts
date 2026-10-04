import { createWriteStream, mkdirSync, readdirSync, statfsSync, statSync, unlinkSync, type WriteStream } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_LOG_CAP_BYTES, diskReserveBytes, SPILL_TOTAL_BYTES } from "../../domain/logs/budgets.ts";
import { partIndexFile, partPatchFile } from "./session-files.ts";

// One write per service per batch instead of one per record.
const BATCH_BYTES = 256 * 1024;
const BATCH_MS = 100;
const MAX_PART_BYTES = 64 * 1024 * 1024;
const PARTS_PER_SESSION = 8;
// A part's index gets a checkpoint for each this many bytes of lines.
const CHECKPOINT_BYTES = 64 * 1024;
const DISK_CHECK_MS = 5_000;
const WRITE_RETRY_MS = 5_000;
// Structured appends are not held back by the ingest pipeline, so past this
// multiple of the pending bound lines are dropped from persistence (the live
// ring keeps them) instead of being buffered without limit.
const HARD_PENDING_FACTOR = 4;

/** Why persistence is currently dropping lines. Each clears on its own. */
export type PersistenceDegraded = "disk-low" | "write-error" | "backlog";

export type SessionWriterOptions = {
  maxSessionBytes?: number;
  /** Called when a service file rolls to a new part. */
  onRotate?: () => void;
  /** Test seam: whether the volume still has its free-space reserve. */
  hasDiskReserve?: (directory: string) => boolean;
  now?: () => number;
};

type Part = {
  path: string;
  bytes: number;
  // Bytes of the files kept beside the part. They count toward the session and go when the part goes.
  sidecarBytes: number;
  // Seqs of the first and last line written, 0 until a line carries one.
  firstSeq: number;
  lastSeq: number;
  // An index is kept for a part whose first line carried a seq.
  indexed: boolean;
  // Offset of the last index checkpoint.
  checkpointAt: number;
  // The appends to the part's sidecars so far, in order.
  sidecars: Promise<void>;
  // Settles once the part's stream is closed, so it can be deleted everywhere.
  closed: Promise<void>;
};

function newPart(path: string, bytes: number, sidecarBytes: number): Part {
  return { path, bytes, sidecarBytes, firstSeq: 0, lastSeq: 0, indexed: false, checkpointAt: 0, sidecars: Promise.resolve(), closed: Promise.resolve() };
}

type KeyState = {
  key: string;
  sealed: Part[];
  active: Part | undefined;
  stream: WriteStream | undefined;
  nextPart: number;
  buffer: string[];
  sizes: number[];
  // The seq of each buffered line, 0 when the caller gave none.
  seqs: number[];
  bufferBytes: number;
};

/**
 * Persists JSONL lines per service. Lines are batched into one write per
 * service every 100 ms or 256 KiB. Each service rolls to numbered part files,
 * and the oldest parts of the largest services are deleted to keep the
 * session under its byte cap, so a full session keeps its newest lines. A
 * low disk or a failed write drops lines from persistence (counted in `loss`)
 * until the condition clears; nothing here ever stops ingestion.
 *
 * A part whose lines carry seqs gets an index beside it, `<part>.idx`: lines
 * of `offset bound`, where every seq written before `offset` is at most
 * `bound`. The first is `0` with the part's first seq less one, then one each
 * 64 KiB, and a sealed part ends with its size and last seq. A reader seeks
 * with it instead of probing the part.
 */
export class SessionLogWriter {
  private readonly keys = new Map<string, KeyState>();
  private sessionBytes = 0;
  private buffered = 0;
  private writing = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly waiters: Array<() => void> = [];
  private readonly removals = new Set<Promise<void>>();
  private diskCheckedAt = Number.NEGATIVE_INFINITY;
  private diskOk = true;
  private writeFailedAt = Number.NEGATIVE_INFINITY;
  private readonly maxSessionBytes: number;
  private readonly partBytes: number;
  private readonly hasDiskReserve: (directory: string) => boolean;
  private readonly now: () => number;
  private readonly onRotate: () => void;
  // Files found in the directory at start, oldest first. Evicted before any part written here.
  private readonly inherited: Part[] = [];
  loss = 0;
  degraded: PersistenceDegraded | undefined;

  constructor(
    private readonly directory: string,
    private readonly pendingLimit = SPILL_TOTAL_BYTES,
    options: SessionWriterOptions = {},
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.maxSessionBytes = options.maxSessionBytes && options.maxSessionBytes > 0 ? options.maxSessionBytes : DEFAULT_LOG_CAP_BYTES;
    this.partBytes = Math.max(1, Math.min(MAX_PART_BYTES, Math.floor(this.maxSessionBytes / PARTS_PER_SESSION)));
    this.hasDiskReserve = options.hasDiskReserve ?? volumeHasReserve;
    this.now = options.now ?? Date.now;
    this.onRotate = options.onRotate ?? (() => undefined);
    for (const part of existingParts(directory)) {
      this.inherited.push(part);
      this.sessionBytes += part.bytes + part.sidecarBytes;
    }
  }

  sessionByteCount(): number {
    return this.sessionBytes;
  }

  /** Bytes accepted but not yet written. */
  pendingBytes(): number {
    return this.buffered + this.writing;
  }

  /** True while writes lag; the caller may slow the pipeline, and it clears as writes land. */
  backpressured(): boolean {
    return this.pendingBytes() > this.pendingLimit;
  }

  /** `seq` is the record's, when the line is a stored record; it feeds the part's index. */
  write(key: string, line: string, seq = 0): void {
    const bytes = Buffer.byteLength(line);
    if (!this.diskAllows() || !this.writesAllowed()) {
      this.loss += 1;
      return;
    }
    if (this.pendingBytes() + bytes > this.pendingLimit * HARD_PENDING_FACTOR) {
      this.loss += 1;
      this.degraded = "backlog";
      return;
    }
    if (this.degraded === "backlog") {
      this.degraded = undefined;
    }
    const state = this.keyState(key);
    state.buffer.push(line);
    state.sizes.push(bytes);
    state.seqs.push(seq);
    state.bufferBytes += bytes;
    this.buffered += bytes;
    if (state.bufferBytes >= BATCH_BYTES) {
      this.flushKey(state);
      return;
    }
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    this.flushAll();
    if (this.pendingBytes() !== 0) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    await Promise.all([...this.removals]);
  }

  async close(): Promise<void> {
    await this.flush();
    const closing: Promise<void>[] = [];
    for (const state of this.keys.values()) {
      if (state.stream !== undefined && state.active !== undefined) {
        const part = this.seal(state);
        closing.push(part.closed, part.sidecars);
      }
    }
    await Promise.all(closing);
    this.keys.clear();
  }

  private flushAll(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const state of this.keys.values()) {
      this.flushKey(state);
    }
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushAll();
    }, BATCH_MS);
    this.timer.unref?.();
  }

  private flushKey(state: KeyState): void {
    if (state.bufferBytes === 0) {
      return;
    }
    const lines = state.buffer;
    const sizes = state.sizes;
    const seqs = state.seqs;
    let total = state.bufferBytes;
    state.buffer = [];
    state.sizes = [];
    state.seqs = [];
    state.bufferBytes = 0;
    this.buffered -= total;
    if (!this.writesAllowed()) {
      this.loss += lines.length;
      this.settle();
      return;
    }
    // A batch larger than the whole session keeps its newest lines, as rotation would.
    let index = 0;
    while (total > this.maxSessionBytes && index < lines.length - 1) {
      total -= sizes[index]!;
      index += 1;
    }
    // Split at line boundaries so every part stays within its size, except a
    // single line larger than a part, which gets a part of its own.
    while (index < lines.length) {
      const stream = this.streamFor(state, sizes[index]!);
      const room = Math.max(this.partBytes - state.active!.bytes, sizes[index]!);
      let end = index;
      let bytes = 0;
      while (end < lines.length && bytes + sizes[end]! <= room) {
        bytes += sizes[end]!;
        end += 1;
      }
      this.indexLines(state.active!, seqs, sizes, index, end);
      this.writeBatch(state, stream, lines.slice(index, end).join(""), bytes, end - index);
      index = end;
    }
    this.evictOverCap();
  }

  // Notes where lines about to be written land in their part: its first
  // seq, then a checkpoint each CHECKPOINT_BYTES.
  private indexLines(part: Part, seqs: number[], sizes: number[], from: number, to: number): void {
    let offset = part.bytes;
    let entries = "";
    for (let line = from; line < to; line += 1) {
      const seq = seqs[line]!;
      if (offset === 0) {
        part.indexed = seq > 0;
        entries = part.indexed ? `0 ${seq - 1}\n` : "";
      } else if (part.indexed && offset - part.checkpointAt >= CHECKPOINT_BYTES) {
        entries += `${offset} ${part.lastSeq}\n`;
        part.checkpointAt = offset;
      }
      if (seq > 0) {
        part.firstSeq = part.firstSeq === 0 ? seq : part.firstSeq;
        part.lastSeq = Math.max(part.lastSeq, seq);
      }
      offset += sizes[line]!;
    }
    if (entries !== "") {
      this.appendSidecar(part, partIndexFile(part.path), entries);
    }
  }

  // Appends to a file beside a part, after the part's earlier sidecar
  // appends. The bytes count toward the session. `lines` are lost if it fails.
  private appendSidecar(part: Part, path: string, text: string, lines = 0): void {
    const bytes = Buffer.byteLength(text);
    part.sidecarBytes += bytes;
    this.sessionBytes += bytes;
    this.writing += bytes;
    part.sidecars = part.sidecars
      .then(() => appendFile(path, text, { mode: 0o600 }))
      .catch(() => {
        // A missing index entry only costs a reader a seek.
        this.loss += lines;
      })
      .then(() => {
        this.writing -= bytes;
        this.settle();
      });
  }

  private writeBatch(state: KeyState, stream: WriteStream, data: string, bytes: number, lines: number): void {
    state.active!.bytes += bytes;
    this.sessionBytes += bytes;
    this.writing += bytes;
    stream.write(data, (err) => {
      this.writing -= bytes;
      if (err) {
        this.loss += lines;
        this.noteWriteError(state, stream);
      }
      this.settle();
    });
  }

  // The stream for the key's active part, rolling to a new part when this batch would overfill it.
  private streamFor(state: KeyState, incoming: number): WriteStream {
    if (state.active !== undefined && state.stream !== undefined && state.active.bytes > 0 && state.active.bytes + incoming > this.partBytes) {
      state.sealed.push(this.seal(state));
    }
    if (state.stream !== undefined && state.active !== undefined) {
      return state.stream;
    }
    const index = state.nextPart;
    state.nextPart += 1;
    const path = join(this.directory, partFileName(state.key, index));
    const stream = createWriteStream(path, { flags: "a", mode: 0o600 });
    stream.on("error", () => {
      this.noteWriteError(state, stream);
    });
    state.stream = stream;
    state.active = newPart(path, 0, 0);
    if (index > 0) {
      this.onRotate();
    }
    return stream;
  }

  private seal(state: KeyState): Part {
    const part = state.active!;
    const stream = state.stream;
    state.active = undefined;
    state.stream = undefined;
    if (part.indexed) {
      this.appendSidecar(part, partIndexFile(part.path), `${part.bytes} ${part.lastSeq}\n`);
    }
    part.closed = stream === undefined
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          // "close" follows both a clean end and a destroy after an error.
          stream.once("close", () => resolve());
          stream.end();
        });
    return part;
  }

  // Deletes the oldest parts until the session fits its cap: files inherited
  // from an earlier writer first, then the oldest part of the largest service.
  // A service's active part is sealed only when nothing else is left to delete.
  private evictOverCap(): void {
    while (this.sessionBytes > this.maxSessionBytes) {
      const inherited = this.inherited.shift();
      if (inherited !== undefined) {
        this.dropPart(inherited);
        continue;
      }
      const victim = this.largestKey();
      if (victim === undefined) {
        return;
      }
      if (victim.sealed.length === 0) {
        if (victim.active === undefined || victim.active.bytes === 0) {
          return;
        }
        victim.sealed.push(this.seal(victim));
      }
      this.dropPart(victim.sealed.shift()!);
    }
  }

  private largestKey(): KeyState | undefined {
    let best: KeyState | undefined;
    let bestBytes = 0;
    for (const state of this.keys.values()) {
      let bytes = state.active === undefined ? 0 : state.active.bytes + state.active.sidecarBytes;
      for (const part of state.sealed) {
        bytes += part.bytes + part.sidecarBytes;
      }
      if (bytes > bestBytes) {
        best = state;
        bestBytes = bytes;
      }
    }
    return best;
  }

  private dropPart(part: Part): void {
    this.sessionBytes -= part.bytes + part.sidecarBytes;
    const removal = part.closed
      .then(() => part.sidecars)
      .then(() => {
        removeQuiet(part.path);
        removeQuiet(partIndexFile(part.path));
        removeQuiet(partPatchFile(part.path));
      });
    this.removals.add(removal);
    void removal.then(() => this.removals.delete(removal));
  }

  private noteWriteError(state: KeyState, stream: WriteStream): void {
    this.degraded = "write-error";
    this.writeFailedAt = this.now();
    if (state.stream === stream) {
      state.sealed.push(this.seal(state));
    }
    stream.destroy();
  }

  private writesAllowed(): boolean {
    if (this.now() - this.writeFailedAt < WRITE_RETRY_MS) {
      return false;
    }
    if (this.degraded === "write-error") {
      this.degraded = undefined;
    }
    return true;
  }

  private diskAllows(): boolean {
    const now = this.now();
    if (now - this.diskCheckedAt < DISK_CHECK_MS) {
      return this.diskOk;
    }
    this.diskCheckedAt = now;
    this.diskOk = this.hasDiskReserve(this.directory);
    if (!this.diskOk) {
      this.degraded = "disk-low";
    } else if (this.degraded === "disk-low") {
      this.degraded = undefined;
    }
    return this.diskOk;
  }

  private settle(): void {
    if (this.pendingBytes() !== 0) {
      return;
    }
    for (const resolve of this.waiters.splice(0, this.waiters.length)) {
      resolve();
    }
  }

  private keyState(key: string): KeyState {
    const existing = this.keys.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: KeyState = { key, sealed: [], active: undefined, stream: undefined, nextPart: firstFreePart(this.directory, key), buffer: [], sizes: [], seqs: [], bufferBytes: 0 };
    this.keys.set(key, created);
    return created;
  }
}

// Parts already in the directory, with the sidecars beside them. A sidecar
// whose part is gone (an older devctl evicts only the part) is removed.
function existingParts(directory: string): Part[] {
  const parts: { part: Part; mtime: number }[] = [];
  const names = readdirQuiet(directory);
  const kept = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    try {
      const st = statSync(join(directory, name));
      const sidecars = [partIndexFile(name), partPatchFile(name)];
      const sidecarBytes = sidecars.reduce((sum, sidecar) => sum + (names.includes(sidecar) ? fileSize(join(directory, sidecar)) : 0), 0);
      sidecars.forEach((sidecar) => kept.add(sidecar));
      parts.push({ part: newPart(join(directory, name), st.size, sidecarBytes), mtime: st.mtimeMs });
    } catch {
      // removed between listing and stat
    }
  }
  for (const name of names) {
    if ((name.endsWith(".idx") || name.endsWith(".patch")) && !kept.has(name)) {
      removeQuiet(join(directory, name));
    }
  }
  return parts.sort((a, b) => a.mtime - b.mtime).map((row) => row.part);
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// Part 0 keeps the historical `<service>.jsonl` name. Later parts use `~`,
// which a service file name never contains, so parts of different services
// cannot collide.
function partFileName(key: string, index: number): string {
  return index === 0 ? `${key}.jsonl` : `${key}~${index}.jsonl`;
}

// Part numbers already on disk for this key (from an earlier writer) are never reused.
function firstFreePart(directory: string, key: string): number {
  let next = 0;
  const prefix = `${key}~`;
  for (const name of readdirQuiet(directory)) {
    if (name === `${key}.jsonl`) {
      next = Math.max(next, 1);
    } else if (name.startsWith(prefix) && name.endsWith(".jsonl")) {
      const index = Number(name.slice(prefix.length, -".jsonl".length));
      if (Number.isInteger(index) && index > 0) {
        next = Math.max(next, index + 1);
      }
    }
  }
  return next;
}

function readdirQuiet(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function removeQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
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
