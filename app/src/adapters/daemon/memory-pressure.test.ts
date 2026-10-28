import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../domain/config/types.ts";
import { LLM_OPERATION_CHAT, LLM_STATUS_OK } from "../../domain/llm/llm.ts";
import type { LlmCallStore } from "../../ports/llm-call-store.ts";
import type { LogStore } from "../../ports/log-store.ts";
import type { SpanStore } from "../../ports/span-store.ts";
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
  const spans = (sup as unknown as { spans: SpanStore }).spans;
  return { sup, cfg, logs, budgets, llm, spans, close: () => manager.close() };
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

  // 100 spans of about 1 MiB each, as an LLM trace with whole prompts carries.
  function fill(spans: SpanStore, from: number): void {
    for (let n = from; n < from + 100; n += 1) {
      spans.append({
        traceId: n.toString(16).padStart(32, "0"),
        spanId: n.toString(16).padStart(16, "0"),
        name: `chat ${n}`,
        kind: "client",
        startUnixNano: 1,
        endUnixNano: 2,
        status: { code: "ok" },
        attributes: { "gen_ai.prompt": "p".repeat(MIB) },
        events: [],
        links: [],
        resource: { "service.name": "agent" },
      });
    }
  }
  const held = (spans: SpanStore): number => spans.recent(1_000).length;

  test("the trace store is held to its byte budget, and the guard trims and restores it with the ring", async () => {
    const { sup, spans, close } = harness();
    try {
      // The default budget is 64 MiB: about 63 of these spans.
      fill(spans, 1);
      expect(held(spans)).toBeGreaterThan(55);
      expect(held(spans)).toBeLessThan(64);
      sup.applyMemoryPressure(80, 100);
      expect(held(spans)).toBeGreaterThan(27);
      expect(held(spans)).toBeLessThan(32);
      sup.applyMemoryPressure(95, 100);
      expect(held(spans)).toBeGreaterThan(13);
      expect(held(spans)).toBeLessThan(16);
      expect(spans.recent(1)[0]?.name).toBe("chat 100");
      // Back to normal, it fills to the whole budget again.
      sup.applyMemoryPressure(50, 100);
      sup.applyMemoryPressure(40, 100);
      fill(spans, 101);
      expect(held(spans)).toBeGreaterThan(55);
      expect(spans.recent(1)[0]?.name).toBe("chat 200");
    } finally {
      await close();
    }
  });

  test("a budget set in the configuration is used, and one changed by a reload is taken up", async () => {
    const dir = join(process.env.TMPDIR ?? "/tmp", `devctl-span-budget-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    process.env.DEVCTL_HOME = dir;
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.telemetry.store_max_bytes = 8 * MIB;
    const sup = new Supervisor(cfg);
    const spans = (sup as unknown as { spans: SpanStore }).spans;
    fill(spans, 1);
    expect(held(spans)).toBe(7);
    // A reload replaces the values in the live configuration; the next guard tick applies them.
    cfg.telemetry.store_max_bytes = 3 * MIB;
    sup.applyMemoryPressure(10, 100);
    expect(held(spans)).toBe(2);
    await sup.shutdown(false);
  });
});
