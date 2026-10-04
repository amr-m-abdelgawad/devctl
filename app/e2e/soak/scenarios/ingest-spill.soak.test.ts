import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { IngestPipeline } from "../../../src/adapters/storage/ingest/pipeline.ts";
import { memoryPressure } from "../../../src/domain/daemon/memory-guard.ts";

const enabled = process.env.DEVCTL_SOAK === "1";
const CHUNKS = 40;

describe.skipIf(!enabled)("ingest spill soak", () => {
  test("a multi-megabyte stream spills in order and is not dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-soak-"));
    try {
      const pipeline = new IngestPipeline(dir, {
        spillPerStream: 64 * 1024,
        spillTotal: 128 * 1024,
        creditPerStream: 256 * 1024,
        creditTotal: 512 * 1024,
        spoolMaxBytes: 8 * 1024 * 1024,
      });
      let refused = 0;
      for (let i = 0; i < CHUNKS; i += 1) {
        // One line per chunk, numbered so the order can be checked.
        const chunk = Buffer.alloc(32 * 1024, 0x61);
        chunk.write(`${String(i).padStart(4, "0")} `);
        chunk[chunk.length - 1] = 0x0a;
        // Spool writes are asynchronous: a chunk past the credit window is refused until one lands.
        while (!pipeline.enqueueChunk({ session: "s", service: "api", stream: "stdout", pid: 1, readAtMs: i, bytes: chunk })) {
          refused += 1;
          await pipeline.settle();
        }
      }
      const lines: { line: string; readAtMs: number }[] = [];
      while (pipeline.pending()) {
        pipeline.processSlice((line) => lines.push({ line: line.line, readAtMs: line.readAtMs }), 1_000);
        await pipeline.settle();
      }
      expect(refused).toBeGreaterThan(0);
      expect(lines.map((row) => row.line.slice(0, 4))).toEqual(Array.from({ length: CHUNKS }, (_, i) => String(i).padStart(4, "0")));
      expect(lines.map((row) => row.readAtMs)).toEqual(Array.from({ length: CHUNKS }, (_, i) => i));
      expect(pipeline.loss).toBe(0);
      expect(pipeline.spooledBytes()).toBe(0);
      expect(memoryPressure(1, 10)).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
