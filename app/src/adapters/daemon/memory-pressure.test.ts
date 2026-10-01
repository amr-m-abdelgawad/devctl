import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../domain/config/types.ts";
import { LLM_OPERATION_CHAT, LLM_STATUS_OK } from "../../domain/llm/llm.ts";
import type { LlmCallStore } from "../../ports/llm-call-store.ts";
import type { LogStore } from "../../ports/log-store.ts";
import { Supervisor } from "../../bootstrap/test-supervisor.ts";
import { LogManager, inProcessLogStore } from "../storage/logs.ts";
import { Detector } from "../secrets/detector.ts";

const MIB = 1024 * 1024;

function harness() {
  const dir = join(process.env.TMPDIR ?? "/tmp", `devctl-mem-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  process.env.DEVCTL_HOME = dir;
  const cfg = defaultConfig();
  cfg.repoRoot = dir;
  cfg.logs.persistence.enabled = false;
  cfg.logs.max_memory_bytes = 64 * MIB;
  const manager = new LogManager(1_000, undefined, new Detector([], []), false, dir, "mem", 0, 0);
  const real = inProcessLogStore(manager);
  const budgets: number[] = [];
  const logs: LogStore = {
    ...real,
    setMemoryBudget: (bytes) => {
      budgets.push(bytes);
      real.setMemoryBudget?.(bytes);
    },
  };
  const sup = new Supervisor(cfg, { logs });
  const llm = (sup as unknown as { llmStore: LlmCallStore }).llmStore;
  return { sup, logs, budgets, llm, close: () => manager.close() };
}

const chunk = () => ({ service: "api", stream: "stdout", pid: 1, readAtMs: Date.now(), bytes: Buffer.from("line\n") });

describe("memory guard", () => {
  test("shedding drops capture bodies but never stops service output from being read", async () => {
    const { sup, logs, llm, close } = harness();
    try {
      llm.upsert([{ id: "c1", source: "proxy", sourceType: "proxy", timestamp: "2026-01-01T00:00:00.000Z", status: LLM_STATUS_OK, model: "gpt-4o", operation: LLM_OPERATION_CHAT, attributes: {}, request: { prompt: "hello" } }]);
      sup.applyMemoryPressure(95, 100);
      expect(logs.ingestPaused?.()).toBe(false);
      expect(logs.ingestChunk?.(chunk())).toBe(true);
      expect(sup.queryLlmCall("c1")?.request).toBeUndefined();
      expect(sup.queryLlmCall("c1")?.attributes.body).toBe("evicted");
      sup.applyMemoryPressure(80, 100);
      expect(logs.ingestPaused?.()).toBe(false);
      expect(logs.ingestChunk?.(chunk())).toBe(true);
    } finally {
      await close();
    }
  });

  test("trims the ring by level, holds it while usage falls, and restores it once", async () => {
    const { sup, budgets, close } = harness();
    try {
      sup.applyMemoryPressure(50, 100);
      expect(budgets).toEqual([]);
      sup.applyMemoryPressure(80, 100);
      expect(budgets).toEqual([32 * MIB]);
      sup.applyMemoryPressure(95, 100);
      sup.applyMemoryPressure(95, 100);
      expect(budgets).toEqual([32 * MIB, 16 * MIB]);
      // Shed holds while usage is above 75%, and shrink holds down to 60%.
      sup.applyMemoryPressure(80, 100);
      expect(budgets).toEqual([32 * MIB, 16 * MIB]);
      sup.applyMemoryPressure(70, 100);
      sup.applyMemoryPressure(65, 100);
      expect(budgets).toEqual([32 * MIB, 16 * MIB, 32 * MIB]);
      sup.applyMemoryPressure(50, 100);
      sup.applyMemoryPressure(40, 100);
      expect(budgets).toEqual([32 * MIB, 16 * MIB, 32 * MIB, 64 * MIB]);
    } finally {
      await close();
    }
  });
});
