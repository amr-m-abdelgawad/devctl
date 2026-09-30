// Differential oracle for log ingest: main's append path (frozen under
// test/oracle/pre-branch) against this branch's LogManager.acceptChunk +
// IngestPipeline, on the fixtures in fixtures.ts.
//
// - live:    this branch with default pipeline limits must store what main
//            stored, lane by lane, except each fixture's declared differences.
// - spooled: the same bytes forced through the on-disk spool must store
//            exactly what the live run stored.
// - backlog: spooled, and parsed only after every read, must still store what
//            the live run stored. Needs event-time folding (Track A), so it is
//            gated on DEVCTL_SOAK_REQUIRE=event-time-folding.
//
// A lane is one service's source and stream; records are compared in each
// lane's own order because the pipeline is byte-fair across streams, so the
// order between lanes is not an invariant. Every stored time must be the read
// time of one of the lane's reads.
//
// test/oracle is excluded from knip (knip.jsonc) and jscpd (.jscpd.json):
// pre-branch/ is main's code copied verbatim, so it duplicates src/ and keeps
// main's unused exports by design. Do not edit it to satisfy either tool.
import { describe, expect, test } from "bun:test";
import { gateEnabled, gatedName } from "../../e2e/soak/gates.ts";
import { FIXTURES } from "./fixtures.ts";
import { declaredDiffs, diffRecords, runCurrent, runOracle, unreadTimestamps, type Diff } from "./ingest-harness.ts";

const FIXTURE_TIMEOUT_MS = 30_000;

function sorted(diffs: Diff[]): Diff[] {
  return [...diffs].sort((a, b) => a.lane.localeCompare(b.lane) || a.index - b.index || a.field.localeCompare(b.field));
}

describe("ingest oracle", () => {
  for (const fixture of FIXTURES) {
    describe(fixture.name, () => {
      const liveName = "live output matches main except the declared differences";
      const runLive = fixture.gate === undefined || gateEnabled(fixture.gate);
      test.skipIf(!runLive)(fixture.gate === undefined ? liveName : gatedName(fixture.gate, liveName), async () => {
        const oracle = runOracle(fixture);
        const current = await runCurrent(fixture, "live");
        expect(oracle.length).toBeGreaterThan(0);
        expect(sorted(diffRecords(oracle, current))).toEqual(sorted(declaredDiffs(fixture)));
        expect(unreadTimestamps(fixture, current)).toEqual([]);
      }, FIXTURE_TIMEOUT_MS);

      test("spooled output matches live output", async () => {
        const live = await runCurrent(fixture, "live");
        const spooled = await runCurrent(fixture, "spooled");
        expect(diffRecords(live, spooled)).toEqual([]);
        expect(unreadTimestamps(fixture, spooled)).toEqual([]);
      }, FIXTURE_TIMEOUT_MS);

      test.skipIf(!gateEnabled("event-time-folding"))(gatedName("event-time-folding", "backlogged output matches live output"), async () => {
        const live = await runCurrent(fixture, "live");
        const backlog = await runCurrent(fixture, "backlog");
        expect(diffRecords(live, backlog)).toEqual([]);
        expect(unreadTimestamps(fixture, backlog)).toEqual([]);
      }, FIXTURE_TIMEOUT_MS);
    });
  }

  test("every intended difference names its reason", () => {
    for (const fixture of FIXTURES) {
      for (const diff of fixture.intended ?? []) {
        expect(diff.reason.length).toBeGreaterThan(20);
      }
    }
  });

  test("the comparator reports a corrupted record", async () => {
    const fixture = FIXTURES.find((row) => row.name === "stdout and stderr interleaved")!;
    const live = await runCurrent(fixture, "live");
    const target = live.find((record) => record.stream === "stderr" && record.body === "WARN err-2")!;
    const corrupted = live.map((record) => (record === target
      ? { ...record, severityText: "CORRUPTED", attributes: { ...record.attributes, extra: "x" } }
      : record));
    expect(sorted(diffRecords(live, corrupted))).toEqual([
      { lane: "mix/stderr/stderr", index: 1, field: "attributes", oracle: JSON.stringify(target.attributes), current: JSON.stringify({ ...target.attributes, extra: "x" }) },
      { lane: "mix/stderr/stderr", index: 1, field: "severityText", oracle: JSON.stringify(target.severityText), current: "\"CORRUPTED\"" },
    ]);
    expect(diffRecords(live, live.filter((record) => record !== target))).toEqual([
      { lane: "mix/stderr/stderr", index: 1, field: "record", oracle: `"WARN err-2" @t+3`, current: "<absent>" },
    ]);
  });
});
