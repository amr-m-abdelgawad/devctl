import { describe, expect, test } from "bun:test";
import { FacetWindow, filtersDimensionsOnly } from "./facet-window.ts";
import { logRecord } from "./record.ts";
import type { LogRecord } from "./types.ts";

function record(seq: number, service: string, level: string, source = "stdout"): LogRecord {
  return logRecord({ seq, service, level, source, message: `line ${seq}` });
}

describe("facet window", () => {
  test("counts the last `size` seqs, each breakdown ignoring its own dimension", () => {
    const window = new FacetWindow(6);
    const rows: Array<[string, string, string]> = [
      ["api", "INFO", "stdout"],
      ["api", "ERROR", "stdout"],
      ["api", "ERROR", "stderr"],
      ["worker", "INFO", "stdout"],
      ["worker", "INFO", "stderr"],
      ["worker", "ERROR", "stderr"],
    ];
    rows.forEach(([service, level, source], index) => window.add(record(index + 1, service, level, source)));
    expect(window.facets({})).toEqual({ total: 6, byService: { api: 3, worker: 3 }, byLevel: { INFO: 3, ERROR: 3 }, bySource: { stdout: 3, stderr: 3 } });
    // A level is a minimum: WARN keeps the errors. byLevel still shows what another level would give.
    const filtered = window.facets({ services: ["api"], level: "WARN" });
    expect(filtered.total).toBe(2);
    expect(filtered.byService).toEqual({ api: 2, worker: 1 });
    expect(filtered.byLevel).toEqual({ INFO: 1, ERROR: 2 });
    expect(filtered.bySource).toEqual({ stdout: 1, stderr: 1 });
    // Seqs 7 and 8 push 1 and 2 (api INFO, api ERROR on stdout) out of the window.
    window.add(record(7, "auth", "INFO"));
    window.add(record(8, "auth", "INFO"));
    expect(window.facets({})).toEqual({ total: 6, byService: { api: 1, worker: 3, auth: 2 }, byLevel: { INFO: 4, ERROR: 2 }, bySource: { stdout: 3, stderr: 3 } });
  });

  test("stays exact while level names come and go", () => {
    const window = new FacetWindow(100);
    for (let seq = 1; seq <= 20_000; seq += 1) {
      window.add(logRecord({ seq, service: "api", source: "stdout", severityNumber: 9, severityText: `LEVEL-${seq % 5_000}`, message: "x" }));
    }
    const facets = window.facets({});
    expect(facets.total).toBe(100);
    expect(Object.keys(facets.byLevel)).toHaveLength(100);
    expect(facets.byLevel["LEVEL-4999"]).toBe(1);
    expect((window as unknown as { combinations: unknown[] }).combinations.length).toBeLessThan(2_200);
  });

  test("only service, level and source filters can be answered from it", () => {
    expect(filtersDimensionsOnly({ services: ["api"], level: "ERROR", source: "stderr", regex: true, dedupeRequestId: true })).toBe(true);
    for (const filter of [{ search: "x" }, { since: "2026-01-01" }, { until: "2026-01-01" }, { traceId: "t" }, { requestId: "r" }, { attribute: { key: "k", value: "v" } }]) {
      expect(filtersDimensionsOnly(filter)).toBe(false);
    }
  });
});
