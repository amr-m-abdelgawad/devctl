import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAGIC = Buffer.from("DVSP");
const HEADER_BYTES = 4;
const UINT32 = 4;
const UINT64_PLACE = 8;
const SEGMENT_SUFFIX = ".spool";
const SEGMENT_DIGITS = 8;

export type SpoolHeader = {
  session: string;
  service: string;
  stream: string;
  pid: number;
};

export type SpoolFrame = {
  readAtMs: number;
  bytes: Buffer;
};

export type SpoolSegment = {
  header: SpoolHeader | undefined;
  frames: SpoolFrame[];
  /** Bytes the segment took on disk. */
  bytes: number;
};

export type SpoolAppendResult = "ok" | "full" | "disk";

type Decoded = { header: SpoolHeader | undefined; frames: SpoolFrame[] };

/**
 * Ordered per-stream spill: one file per appended segment, read back oldest
 * first one segment at a time, so draining never holds more than a segment in
 * memory. Files are mode 0600 and deleted as they are read. The payload is the
 * not-yet-redacted output the daemon has not parsed yet.
 *
 * The daemon uses the asynchronous methods, so spool I/O never blocks its
 * thread; the blocking ones are for the FIFO drainer process, which has
 * nothing else to do. A segment joins the queue only once fully written, and a
 * caller keeps one write in flight per spool so segments stay in order.
 */
export class OrderedSpool {
  private bytes = 0;
  private nextIndex = 0;
  private readonly segments: { path: string; bytes: number }[] = [];
  private made = false;
  readonly directory: string;

  constructor(
    directory: string,
    private readonly maxBytes = Number.POSITIVE_INFINITY,
  ) {
    this.directory = directory;
    // A directory an earlier owner left behind is read back in order too.
    for (const name of segmentNames(directory)) {
      const path = join(directory, name);
      const size = fileSize(path);
      this.segments.push({ path, bytes: size });
      this.bytes += size;
      this.nextIndex = Math.max(this.nextIndex, Number.parseInt(name, 10) + 1);
      this.made = true;
    }
  }

  size(): number {
    return this.bytes;
  }

  segmentCount(): number {
    return this.segments.length;
  }

  /**
   * Writes the frames as the newest segment, blocking. `room` is what the
   * caller's own budget still allows; a segment that does not fit is refused whole.
   */
  append(header: SpoolHeader, frames: readonly SpoolFrame[], room = Number.POSITIVE_INFINITY): SpoolAppendResult {
    const payload = encodeSegment(header, frames);
    if (payload.length > room || this.bytes + payload.length > this.maxBytes) {
      return "full";
    }
    const path = this.nextPath();
    try {
      if (!this.made) {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        this.made = true;
      }
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, payload);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      removeQuiet(path);
      return failedWrite(err);
    }
    return this.enqueue(path, payload.length);
  }

  /**
   * Writes an encoded segment (`encodeSegment`) as the newest one without
   * blocking. The caller has checked its own budget; the segment can be read
   * only after this settles "ok". An error other than a full disk rejects.
   */
  async write(payload: Buffer): Promise<SpoolAppendResult> {
    if (this.bytes + payload.length > this.maxBytes) {
      return "full";
    }
    const path = this.nextPath();
    try {
      if (!this.made) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        this.made = true;
      }
      await writeFile(path, payload, { flag: "wx", mode: 0o600 });
    } catch (err) {
      await unlink(path).catch(() => undefined);
      return failedWrite(err);
    }
    return this.enqueue(path, payload.length);
  }

  /** Reads and deletes the oldest segment. A segment that cannot be read comes back with no frames. */
  consumeNext(): SpoolSegment | undefined {
    const segment = this.peekNext();
    this.dropNext();
    return segment;
  }

  /** Takes the oldest segment off the queue, reads it, and deletes it, without blocking. */
  async consume(): Promise<SpoolSegment | undefined> {
    const next = this.segments.shift();
    if (next === undefined) {
      return undefined;
    }
    this.bytes -= next.bytes;
    const decoded = await readQuiet(next.path);
    await unlink(next.path).catch(() => undefined);
    return { ...decoded, bytes: next.bytes };
  }

  /** Reads the oldest segment and leaves it in place, for a caller that deletes it only once its contents are safe. */
  peekNext(): SpoolSegment | undefined {
    const next = this.segments[0];
    if (next === undefined) {
      return undefined;
    }
    let decoded: Decoded = { header: undefined, frames: [] };
    try {
      decoded = readSegment(readFileSync(next.path));
    } catch {
      // deleted or unreadable: counted by the caller as a segment with no frames
    }
    return { ...decoded, bytes: next.bytes };
  }

  /** `peekNext` without blocking. */
  async read(): Promise<SpoolSegment | undefined> {
    const next = this.segments[0];
    if (next === undefined) {
      return undefined;
    }
    return { ...(await readQuiet(next.path)), bytes: next.bytes };
  }

  dropNext(): void {
    const next = this.segments.shift();
    if (next === undefined) {
      return;
    }
    this.bytes -= next.bytes;
    removeQuiet(next.path);
  }

  /** `dropNext` without blocking. */
  async drop(): Promise<void> {
    const next = this.segments.shift();
    if (next === undefined) {
      return;
    }
    this.bytes -= next.bytes;
    await unlink(next.path).catch(() => undefined);
  }

  /** Deletes the directory and everything still in it. */
  remove(): void {
    rmSync(this.directory, { recursive: true, force: true });
    this.segments.length = 0;
    this.bytes = 0;
  }

  /** `remove` without blocking. */
  async destroy(): Promise<void> {
    this.segments.length = 0;
    this.bytes = 0;
    await rm(this.directory, { recursive: true, force: true });
  }

  private nextPath(): string {
    const path = join(this.directory, `${String(this.nextIndex).padStart(SEGMENT_DIGITS, "0")}${SEGMENT_SUFFIX}`);
    this.nextIndex += 1;
    return path;
  }

  private enqueue(path: string, bytes: number): SpoolAppendResult {
    this.segments.push({ path, bytes });
    this.bytes += bytes;
    return "ok";
  }
}

function failedWrite(err: unknown): SpoolAppendResult {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOSPC" || code === "EDQUOT") {
    return "disk";
  }
  throw err;
}

async function readQuiet(path: string): Promise<Decoded> {
  try {
    return readSegment(await readFile(path));
  } catch {
    // deleted or unreadable: counted by the caller as a segment with no frames
    return { header: undefined, frames: [] };
  }
}

export function encodeSegment(header: SpoolHeader, frames: readonly SpoolFrame[]): Buffer {
  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  const parts: Buffer[] = [MAGIC, uint32(headerJson.length), headerJson];
  for (const frame of frames) {
    parts.push(uint32(frame.bytes.length), uint64(frame.readAtMs), frame.bytes);
  }
  return Buffer.concat(parts);
}

export function decodeSegment(buf: Buffer): SpoolFrame[] {
  return readSegment(buf).frames;
}

function readSegment(buf: Buffer): { header: SpoolHeader | undefined; frames: SpoolFrame[] } {
  if (buf.length < HEADER_BYTES + UINT32 || !buf.subarray(0, HEADER_BYTES).equals(MAGIC)) {
    return { header: undefined, frames: [] };
  }
  let offset = HEADER_BYTES;
  const headerLen = buf.readUInt32BE(offset);
  offset += UINT32;
  const header = parseHeader(buf.subarray(offset, offset + headerLen));
  offset += headerLen;
  const frames: SpoolFrame[] = [];
  while (offset + UINT32 + UINT64_PLACE <= buf.length) {
    const len = buf.readUInt32BE(offset);
    offset += UINT32;
    const readAtMs = Number(buf.readBigUInt64BE(offset));
    offset += UINT64_PLACE;
    if (offset + len > buf.length) {
      break;
    }
    frames.push({ readAtMs, bytes: Buffer.from(buf.subarray(offset, offset + len)) });
    offset += len;
  }
  return { header, frames };
}

function parseHeader(raw: Buffer): SpoolHeader | undefined {
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as Partial<SpoolHeader>;
    if (typeof parsed.session === "string" && typeof parsed.service === "string" && typeof parsed.stream === "string") {
      return { session: parsed.session, service: parsed.service, stream: parsed.stream, pid: typeof parsed.pid === "number" ? parsed.pid : 0 };
    }
  } catch {
    // corrupt header: the frames are still usable by a caller that knows the stream
  }
  return undefined;
}

function segmentNames(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(SEGMENT_SUFFIX) && /^\d+\.spool$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function removeQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

function uint32(value: number): Buffer {
  const buf = Buffer.alloc(UINT32);
  buf.writeUInt32BE(value);
  return buf;
}

function uint64(value: number): Buffer {
  const buf = Buffer.alloc(UINT64_PLACE);
  buf.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(value))));
  return buf;
}
