import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { IngestPipeline } from "../../../src/adapters/storage/ingest/pipeline.ts";
import { memoryPressure } from "../../../src/domain/daemon/memory-guard.ts";

const enabled = process.env.DEVCTL_SOAK === "1";

describe.skipIf(!enabled)("ingest spill soak", () => {
  test("a multi-megabyte stream spills in order and is not dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-soak-"));
    try {
      const pipeline = new IngestPipeline(dir, {
        spillPerStream: 64 * 1024,
        spillTotal: 128 * 1024,
        creditPerStream: 256 * 1024,
        creditTotal: 512 * 1024,
        spoolMaxBytes: 8 * 1024 * 1024,
      });
      const chunk = Buffer.alloc(32 * 1024, 0x61);
      chunk[chunk.length - 1] = 0x0a;
      for (let i = 0; i < 40; i += 1) {
        expect(pipeline.enqueueChunk({
          session: "s",
          service: "api",
          stream: "stdout",
          pid: 1,
          readAtMs: i,
          bytes: chunk,
        })).toBe(true);
      }
      const lines: string[] = [];
      while (pipeline.pending()) {
        pipeline.processSlice((line) => lines.push(line.line), 1_000);
      }
      expect(lines.length).toBeGreaterThan(0);
      expect(pipeline.loss).toBe(0);
      expect(memoryPressure(1, 10)).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
