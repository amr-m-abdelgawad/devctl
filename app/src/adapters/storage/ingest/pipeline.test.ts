import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

describe("ingest pipeline ordering", () => {
  test("keeps read order and whole lines when chunks arrive while older bytes are spooled", () => {
    const pipeline = new IngestPipeline(tempDir(), {
      spillPerStream: 256,
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
    }
    while (pipeline.pending()) {
      pipeline.processSlice(emit, 1_000);
    }
    expect(out).toEqual(text.trimEnd().split("\n"));
  });
});

describe("ingest pipeline spool budget", () => {
  test("drains a large spool a segment at a time instead of loading it all", () => {
    const pipeline = new IngestPipeline(tempDir(), {
      spillPerStream: 1 << 10,
      spillTotal: 1 << 12,
      creditPerStream: 1 << 20,
      creditTotal: 1 << 21,
      spoolMaxBytes: 1 << 26,
    });
    const line = Buffer.from(`${"y".repeat(16 * 1024 - 1)}\n`);
    for (let i = 0; i < 512; i += 1) {
      expect(pipeline.enqueueChunk(chunk("api", Buffer.from(line), i))).toBe(true);
    }
    expect(pipeline.spooledBytes()).toBeGreaterThan(4 << 20);
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

  test("enforces one spool budget across streams", () => {
    const pipeline = new IngestPipeline(tempDir(), {
      spillPerStream: 1 << 10,
      spillTotal: 1 << 12,
      creditPerStream: 1 << 14,
      creditTotal: 1 << 15,
      spoolMaxBytes: 64 << 10,
    });
    const block = Buffer.from(`${"z".repeat(4095)}\n`);
    for (let i = 0; i < 12; i += 1) {
      pipeline.enqueueChunk(chunk("a", Buffer.from(block), i));
    }
    let refused = false;
    for (let i = 0; i < 12 && !refused; i += 1) {
      refused = !pipeline.enqueueChunk(chunk("b", Buffer.from(block), 100 + i));
    }
    expect(refused).toBe(true);
    expect(pipeline.spooledBytes()).toBeLessThanOrEqual(64 << 10);
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
  test("keeps each stream's order when many streams spill, refuse, and drain interleaved", () => {
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
      }
      for (const service of services) {
        pipeline.endStream({ service, stream: "stdout", pid: 1 });
      }
      while (pipeline.pending()) {
        pipeline.processSlice(emit, 1_000);
      }
      for (const service of services) {
        expect(out.get(service)).toEqual(sources.get(service)!.toString("utf8").trimEnd().split("\n"));
      }
      expect(pipeline.inFlightBytes()).toBe(0);
      expect(pipeline.spooledBytes()).toBe(0);
    }
  });

  test("emits a stream's last unterminated line once the stream ends, then frees it", () => {
    const root = tempDir();
    const pipeline = new IngestPipeline(root, { spillPerStream: 4, spillTotal: 1_024, creditPerStream: 1 << 16, creditTotal: 1 << 17 });
    const lines: string[] = [];
    expect(pipeline.enqueueChunk(chunk("api", Buffer.from("first\nlast without newline"), 1))).toBe(true);
    pipeline.processSlice((line) => lines.push(line.line), 1_000);
    expect(lines).toEqual(["first"]);
    pipeline.endStream({ service: "api", stream: "stdout", pid: 1 });
    pipeline.processSlice((line) => lines.push(line.line), 1_000);
    expect(lines).toEqual(["first", "last without newline"]);
    expect(pipeline.pending()).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  test("at shutdown parses what is next in line and leaves newer bytes spooled for replay", () => {
    const root = tempDir();
    const pipeline = new IngestPipeline(root, { spillPerStream: 64, spillTotal: 1_024, creditPerStream: 1 << 16, creditTotal: 1 << 17 });
    const text = numbered(40);
    pipeline.enqueueChunk(chunk("api", Buffer.from(text.slice(0, 50)), 1));
    pipeline.enqueueChunk(chunk("api", Buffer.from(text.slice(50, 700)), 2));
    pipeline.enqueueChunk(chunk("api", Buffer.from(text.slice(700, 720)), 3));
    expect(pipeline.spooledBytes()).toBeGreaterThan(0);
    const lines: string[] = [];
    pipeline.drainForClose((line) => lines.push(line.line));
    expect(lines.length).toBeGreaterThan(0);
    expect(text.startsWith(lines.join("\n"))).toBe(true);
    expect(pipeline.inFlightBytes()).toBe(0);
    const [dir] = readdirSync(root);
    expect(readdirSync(join(root, dir!)).length).toBeGreaterThanOrEqual(2);
  });
});
