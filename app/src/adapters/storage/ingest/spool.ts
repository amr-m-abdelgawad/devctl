import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

const MAGIC = Buffer.from("DVSP");
const HEADER_BYTES = 4;
const UINT32 = 4;
const UINT64_PLACE = 8;

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

export type SpoolAppendResult = "ok" | "full" | "disk";

/**
 * Ordered per-stream spill. Files are mode 0600 and removed once consumed.
 * Payload is the not-yet-redacted chunk the daemon has not parsed yet.
 */
export class OrderedSpool {
  private bytes = 0;
  private seq = 0;
  readonly directory: string;

  constructor(
    directory: string,
    private readonly maxBytes: number,
  ) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  size(): number {
    return this.bytes;
  }

  append(header: SpoolHeader, frames: readonly SpoolFrame[]): SpoolAppendResult {
    const payload = encodeSegment(header, frames);
    if (this.bytes + payload.length > this.maxBytes) {
      return "full";
    }
    const path = join(this.directory, `${String(this.seq).padStart(8, "0")}.spool`);
    this.seq += 1;
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, payload);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOSPC" || code === "EDQUOT") {
        return "disk";
      }
      throw err;
    }
    this.bytes += payload.length;
    return "ok";
  }

  /** Frames in write order. Segments are deleted as they are read. */
  consume(): SpoolFrame[] {
    const frames: SpoolFrame[] = [];
    const names = this.segmentNames();
    for (const name of names) {
      const path = join(this.directory, name);
      const decoded = decodeSegment(readFileSync(path));
      frames.push(...decoded);
      unlinkSync(path);
    }
    this.bytes = 0;
    return frames;
  }

  discard(): void {
    rmSync(this.directory, { recursive: true, force: true });
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.bytes = 0;
  }

  private segmentNames(): string[] {
    try {
      return readdirSync(this.directory).filter((name) => name.endsWith(".spool")).sort();
    } catch {
      return [];
    }
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
  if (buf.length < HEADER_BYTES || !buf.subarray(0, HEADER_BYTES).equals(MAGIC)) {
    return [];
  }
  let offset = HEADER_BYTES;
  const headerLen = buf.readUInt32BE(offset);
  offset += UINT32 + headerLen;
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
  return frames;
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
