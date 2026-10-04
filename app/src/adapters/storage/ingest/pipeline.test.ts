import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { IngestPipeline, type PipelineChunk, type PipelineLine } from "./pipeline.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "devctl-pipeline-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function numbered(count: number): string {
  return `${Array.from({ length: count }, (_, i) => `line-${String(i).padStart(5, "0")}-${"x".repeat(24)}`).join("\n")}\n`;
}

function chunk(service: string, bytes: Buffer, readAtMs: number): PipelineChunk {
  return { session: "s", service, stream: "stdout", pid: 1, readAtMs, bytes };
}

// Spool writes and reads settle on the thread pool, so draining waits for them.
async function drainAll(pipeline: IngestPipeline, emit: (line: PipelineLine) => void): Promise<void> {
  while (pipeline.pending()) {
    pipeline.processSlice(emit, 1_000);
    await pipeline.settle();
  }
}

// A refused chunk is offered again once the writes in flight settle, as the pump does.
async function offer(pipeline: IngestPipeline, next: PipelineChunk, attempts = 3): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (pipeline.enqueueChunk(next)) {
      return true;
    }
    await pipeline.settle();
  }
  return false;
}

describe("ingest pipeline ordering", () => {
  test("keeps read order and whole lines when chunks arrive while older bytes are spooled", async () => {
    const pipeline = new IngestPipeline(tempDir(), {
      spillPerStream: 64,
      spillTotal: 1024,
      creditPerStream: 1 << 16,
      creditTotal: 1 << 17,
      spoolMaxBytes: 1 << 22,
    });
    const text = numbered(600);
    const bytes = Buffer.from(text);
    const out: string[] = [];
    const emit = (line: PipelineLine): void => {
      out.push(line.line);
    };
    let offset = 0;
    let reads = 0;
    while (offset < bytes.length) {
      // Irregular sizes split lines across chunks; five reads per slice always
      // cross the spill threshold, so newer chunks land while older ones are spooled.
      const size = 29 + ((reads * 17) % 61);
      expect(pipeline.enqueueChunk(chunk("api", Buffer.from(bytes.subarray(offset, offset + size)), reads))).toBe(true);
      offset += size;
      reads += 1;
      if (reads % 5 === 0) {
        pipeline.processSlice(emit, 1_000);
      }
      if (reads % 7 === 0) {
        await pipeline.settle();
      }
    }
    await drainAll(pipeline, emit);
    expect(out).toEqual(text.trimEnd().split("\n"));
    expect(pipeline.spilledSegments).toBeGreaterThan(0);
  });
});

describe("ingest pipeline spool budget", () => {
  test("drains a large spool a segment at a time instead of loading it all", async () => {
    const pipeline = new IngestPipeline(tempDir(), {
      spillPerStream: 1 << 10,
      spillTotal: 1 << 12,
      creditPerStream: 1 << 20,
      creditTotal: 1 << 21,
      spoolMaxBytes: 1 << 26,
    });
    const line = Buffer.from(`${"y".repeat(16 * 1024 - 1)}\n`);
    for (let i = 0; i < 512; i += 1) {
      expect(await offer(pipeline, chunk("api", Buffer.from(line), i))).toBe(true);
    }
    await pipeline.settle();
    expect(pipeline.spooledBytes()).toBeGreaterThan(4 << 20);
    // The first slice starts reading the oldest segment; the next one gets to its lines.
    pipeline.processSlice(() => {}, 1_000);
    await pipeline.settle();
    const stop = new Error("first line");
    try {
      pipeline.processSlice(() => {
        throw stop;
      }, 1_000);
    } catch (err) {
      expect(err).toBe(stop);
    }
    // Only the frames of one spool segment may be in memory after the first read.
    expect(pipeline.inFlightBytes()).toBeLessThan(2 << 20);
  });

  test("enforces one spool budget across streams", async () => {
    const pipeline = new IngestPipeline(tempDir(), {
      spillPerStream: 1 << 10,
      spillTotal: 1 << 12,
      creditPerStream: 1 << 14,
      creditTotal: 1 << 15,
      spoolMaxBytes: 64 << 10,
    });
    const block = Buffer.from(`${"z".repeat(4095)}\n`);
    for (let i = 0; i < 12; i += 1) {
      await offer(pipeline, chunk("a", Buffer.from(block), i));
    }
    // Refused even once every write has settled: the shared spool is full.
    let refused = false;
    for (let i = 0; i < 12 && !refused; i += 1) {
      refused = !(await offer(pipeline, chunk("b", Buffer.from(block), 100 + i)));
    }
    expect(refused).toBe(true);
    await pipeline.settle();
    expect(pipeline.spooledBytes()).toBeLessThanOrEqual(64 << 10);
    expect(pipeline.spooledBytes()).toBeGreaterThan(32 << 10);
  });

  test("a chunk replayed from another spool waits there instead of being spooled again", async () => {
    const root = tempDir();
    const pipeline = new IngestPipeline(root, { spillPerStream: 1 << 10, spillTotal: 1 << 12, creditPerStream: 1 << 14, creditTotal: 1 << 15, spoolMaxBytes: 1 << 20 });
    const text = numbered(200);
    const bytes = Buffer.from(text);
    const out: string[] = [];
    let offset = 0;
    let refusals = 0;
    while (offset < bytes.length) {
      const next = { ...chunk("api", Buffer.from(bytes.subarray(offset, offset + 700)), offset), noSpill: true };
      if (pipeline.enqueueChunk(next)) {
        offset += 700;
      } else {
        refusals += 1;
        // The refusal is the replayer's alone: readers are not told to pause.
        expect(pipeline.paused).toBe(false);
        pipeline.processSlice((line) => out.push(line.line), 1_000);
      }
    }
    await drainAll(pipeline, (line) => out.push(line.line));
    expect(refusals).toBeGreaterThan(0);
    expect(pipeline.spilledSegments).toBe(0);
    expect(readdirSync(root)).toEqual([]);
    expect(out).toEqual(text.trimEnd().split("\n"));
  });

  test("bytes reserved for another spool leave less room in this one", async () => {
    const limits = { spillPerStream: 1 << 10, spillTotal: 1 << 12, creditPerStream: 1 << 14, creditTotal: 1 << 15, spoolMaxBytes: 64 << 10 };
    const block = Buffer.from(`${"z".repeat(4095)}\n`);
    const fill = async (reserved: number): Promise<number> => {
      const pipeline = new IngestPipeline(tempDir(), limits);
      pipeline.reserve(reserved);
      for (let i = 0; i < 24; i += 1) {
        await offer(pipeline, chunk("a", Buffer.from(block), i));
      }
      await pipeline.settle();
      return pipeline.spooledBytes();
    };
    const alone = await fill(0);
    const shared = await fill(40 << 10);
    expect(alone).toBeGreaterThan(48 << 10);
    // With 40 KiB held elsewhere, this spool stops at the 24 KiB that is left.
    expect(shared).toBeLessThanOrEqual(24 << 10);
    expect(shared).toBeGreaterThan(0);
  });

  test("a write that fails keeps its frames in memory, ahead of newer bytes", async () => {
    // The spool root is a file, so every segment write fails.
    const root = join(tempDir(), "not-a-directory");
    writeFileSync(root, "x");
    const pipeline = new IngestPipeline(root, { spillPerStream: 4, spillTotal: 1_024, creditPerStream: 1 << 16, creditTotal: 1 << 17 });
    expect(pipeline.enqueueChunk(chunk("api", Buffer.from("one\ntwo\n"), 1))).toBe(true);
    expect(pipeline.enqueueChunk(chunk("api", Buffer.from("three\n"), 2))).toBe(true);
    const out: string[] = [];
    await drainAll(pipeline, (line) => out.push(line.line));
    expect(out).toEqual(["one", "two", "three"]);
    expect(pipeline.spilledSegments).toBe(0);
    expect(pipeline.inFlightBytes()).toBe(0);
    expect(pipeline.spooledBytes()).toBe(0);
  });

  test("refuses a chunk past the credit before queuing any of it, and takes it once a write frees memory", async () => {
    const pipeline = new IngestPipeline(tempDir(), { spillPerStream: 1 << 10, spillTotal: 1 << 12, creditPerStream: 3 << 10, creditTotal: 1 << 20 });
    const block = (fill: string): Buffer => Buffer.from(`${fill.repeat(1023)}\n`);
    expect(pipeline.enqueueChunk(chunk("api", block("a"), 1))).toBe(true);
    expect(pipeline.enqueueChunk(chunk("api", block("b"), 2))).toBe(true);
    expect(pipeline.enqueueChunk(chunk("api", block("c"), 3))).toBe(true);
    const held = pipeline.inFlightBytes();
    // The first block's segment is still being written, so memory is at the credit.
    expect(pipeline.enqueueChunk(chunk("api", block("d"), 4))).toBe(false);
    expect(pipeline.inFlightBytes()).toBe(held);
    await pipeline.settle();
    expect(pipeline.enqueueChunk(chunk("api", block("d"), 4))).toBe(true);
    const out: string[] = [];
    await drainAll(pipeline, (line) => out.push(line.line[0]!));
    expect(out).toEqual(["a", "b", "c", "d"]);
  });
});

describe("ingest pipeline takeover", () => {
  test("a new owner of a session's spool emits the old owner's bytes first, even for a stream with no new output", async () => {
    const root = tempDir();
    const limits = { spillPerStream: 8, spillTotal: 64, creditPerStream: 1 << 16, creditTotal: 1 << 17 };
    const before = new IngestPipeline(root, limits);
    expect(before.enqueueChunk(chunk("api", Buffer.from("old one\nold two\n"), 1))).toBe(true);
    expect(before.enqueueChunk(chunk("quiet", Buffer.from("quiet old\n"), 1))).toBe(true);
    await before.settle();
    expect(before.spooledBytes()).toBeGreaterThan(0);
    // Its owner dies with that output spooled and unread.
    const after = new IngestPipeline(root, limits);
    expect(after.adoptSession("s")).toBe(2);
    expect(after.spooledBytes()).toBe(before.spooledBytes());
    expect(after.enqueueChunk(chunk("api", Buffer.from("new\n"), 2))).toBe(true);
    const out: string[] = [];
    await drainAll(after, (line) => out.push(`${line.service}: ${line.line}`));
    expect(out.filter((line) => line.startsWith("api:"))).toEqual(["api: old one", "api: old two", "api: new"]);
    expect(out).toContain("quiet: quiet old");
    expect(after.spooledBytes()).toBe(0);
  });
});

describe("ingest pipeline watermark", () => {
  test("a refused stream stays busy until its chunk is taken, and holds the low watermark", () => {
    // No spool room: 232 bytes of another stream leave too little credit for 30 more.
    const pipeline = new IngestPipeline(tempDir(), { spillPerStream: 64, spillTotal: 128, creditPerStream: 1_024, creditTotal: 256, spoolMaxBytes: 1 });
    const api = { service: "api", stream: "stdout", pid: 1 };
    const drain = (): void => {
      while (pipeline.pending()) {
        pipeline.processSlice(() => {}, 1_000);
      }
    };
    for (let i = 0; i < 4; i += 1) {
      expect(pipeline.enqueueChunk(chunk("noise", Buffer.alloc(58, 0x61), 5))).toBe(true);
    }
    const refused = Buffer.from(`refused ${"r".repeat(21)}\n`);
    expect(pipeline.streamBusy(api)).toBe(false);
    expect(pipeline.enqueueChunk(chunk("api", refused, 3))).toBe(false);
    expect(pipeline.streamBusy(api)).toBe(true);
    expect(pipeline.lowWatermark()).toBe(3);
    drain();
    // Nothing of it is queued, but its reader still holds the refused chunk.
    expect(pipeline.streamBusy(api)).toBe(true);
    expect(pipeline.lowWatermark()).toBe(3);
    expect(pipeline.enqueueChunk(chunk("api", refused, 3))).toBe(true);
    expect(pipeline.streamBusy(api)).toBe(true);
    drain();
    expect(pipeline.streamBusy(api)).toBe(false);
    expect(pipeline.lowWatermark()).toBeUndefined();
  });
});

// Small deterministic PRNG so a failing interleaving can be replayed.
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("ingest pipeline streams", () => {
  test("keeps each stream's order when many streams spill, refuse, and drain interleaved", async () => {
    for (const seed of [1, 7, 42, 1_234]) {
      const random = prng(seed);
      const pipeline = new IngestPipeline(tempDir(), {
        spillPerStream: 128 + Math.floor(random() * 512),
        spillTotal: 1_024,
        creditPerStream: 2_048,
        creditTotal: 4_096,
        spoolMaxBytes: 8_192 + Math.floor(random() * 16_384),
      });
      const services = ["a", "b", "c", "d"];
      const sources = new Map(services.map((service) => [service, Buffer.from(`${Array.from({ length: 400 }, (_, i) => `${service}-${i}-${"q".repeat(Math.floor(random() * 40))}`).join("\n")}\n`)]));
      const offsets = new Map(services.map((service) => [service, 0]));
      const out = new Map<string, string[]>(services.map((service) => [service, []]));
      const emit = (line: PipelineLine): void => {
        out.get(line.service)!.push(line.line);
      };
      let reads = 0;
      while ([...offsets.entries()].some(([service, offset]) => offset < sources.get(service)!.length)) {
        const service = services[Math.floor(random() * services.length)]!;
        const source = sources.get(service)!;
        const offset = offsets.get(service)!;
        if (offset < source.length) {
          const size = 1 + Math.floor(random() * 300);
          // A refused chunk is offered again later, exactly as the pump does.
          if (pipeline.enqueueChunk(chunk(service, Buffer.from(source.subarray(offset, offset + size)), reads))) {
            offsets.set(service, offset + size);
          }
        }
        reads += 1;
        if (random() < 0.2) {
          pipeline.processSlice(emit, 1_000);
        }
        // Spool I/O settles between reads at random, as it would under load.
        if (random() < 0.1) {
          await pipeline.settle();
        }
      }
      for (const service of services) {
        pipeline.endStream({ service, stream: "stdout", pid: 1 });
      }
      await drainAll(pipeline, emit);
      for (const service of services) {
        expect(out.get(service)).toEqual(sources.get(service)!.toString("utf8").trimEnd().split("\n"));
      }
      expect(pipeline.inFlightBytes()).toBe(0);
      expect(pipeline.spooledBytes()).toBe(0);
    }
  });

  test("emits a stream's last unterminated line once the stream ends, then frees it", async () => {
    const root = tempDir();
    const pipeline = new IngestPipeline(root, { spillPerStream: 4, spillTotal: 1_024, creditPerStream: 1 << 16, creditTotal: 1 << 17 });
    const lines: string[] = [];
    expect(pipeline.enqueueChunk(chunk("api", Buffer.from("first\nlast without newline"), 1))).toBe(true);
    await drainAll(pipeline, (line) => lines.push(line.line));
    expect(lines).toEqual(["first"]);
    pipeline.endStream({ service: "api", stream: "stdout", pid: 1 });
    await drainAll(pipeline, (line) => lines.push(line.line));
    expect(lines).toEqual(["first", "last without newline"]);
    expect(pipeline.pending()).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  test("at shutdown parses what is next in line and leaves newer bytes spooled for replay", async () => {
    const root = tempDir();
    const pipeline = new IngestPipeline(root, { spillPerStream: 64, spillTotal: 1_024, creditPerStream: 1 << 16, creditTotal: 1 << 17 });
    const text = numbered(40);
    pipeline.enqueueChunk(chunk("api", Buffer.from(text.slice(0, 50)), 1));
    pipeline.enqueueChunk(chunk("api", Buffer.from(text.slice(50, 700)), 2));
    pipeline.enqueueChunk(chunk("api", Buffer.from(text.slice(700, 720)), 3));
    await pipeline.settle();
    expect(pipeline.spooledBytes()).toBeGreaterThan(0);
    const lines: string[] = [];
    await pipeline.drainForClose((line) => lines.push(line.line));
    expect(lines.length).toBeGreaterThan(0);
    expect(text.startsWith(lines.join("\n"))).toBe(true);
    expect(pipeline.inFlightBytes()).toBe(0);
    const [dir] = readdirSync(root);
    expect(readdirSync(join(root, dir!)).length).toBeGreaterThanOrEqual(2);
  });
});
