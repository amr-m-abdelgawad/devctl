// Long lines, and paging history back past the ring.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CONFIG_HEADER, floodService, IMAGE_BUILD_TIMEOUT_MS, MIB, report, SoakContainer, soakEnabled, soakImage, soakQuick, type Latency, type ProbeResult, type VerifyResult } from "../harness/soak.ts";

const RPC_P99_MS = 50;
const RSS_MAX_BYTES = 400_000_000;
// MAX_LOG_LINE_CHARS: a stored line keeps its first 16 Ki UTF-16 units.
const MAX_LINE_CHARS = 16 * 1024;
const WIDE_COUNT = 5_000;

type PageResult = VerifyResult & { pages: number; emptyPages: number; stalledAtEnd: boolean; pageMs: Latency };

describe.skipIf(!soakEnabled || soakQuick)("lines", () => {
  let tag = "";
  const containers: SoakContainer[] = [];

  beforeAll(async () => {
    tag = await soakImage();
  }, IMAGE_BUILD_TIMEOUT_MS);

  afterAll(async () => {
    await wide?.box.devctl(["down"], { allowFail: true });
    await Promise.all(containers.map((container) => container.rm()));
  });

  async function container(): Promise<SoakContainer> {
    const started = await SoakContainer.start(tag);
    containers.push(started);
    return started;
  }

  // One flood of 40 KB lines feeds both tests below.
  let wide: { box: SoakContainer; persisted: VerifyResult; measured: ProbeResult } | undefined;
  async function wideFlood(): Promise<{ box: SoakContainer; persisted: VerifyResult; measured: ProbeResult }> {
    if (wide !== undefined) {
      return wide;
    }
    const box = await container();
    await box.configure(`${CONFIG_HEADER}project:\n  name: soak-wide\nservices:\n  idle:\n    command: [sleep, "3600"]\n${floodService("flood", 500, WIDE_COUNT, { width: 40 * 1024 })}`);
    await box.devctl(["start", "idle"]);
    const probe = box.driver<ProbeResult>("probe.ts", ["--duration-ms", "15000"], { timeoutMs: 60_000 });
    await Bun.sleep(1_000);
    await box.devctl(["start", "flood"]);
    const measured = await probe;
    await box.waitDone("flood");
    const session = (await box.status()).session_id;
    const persisted = await box.verifySessions([session], "flood", WIDE_COUNT);
    report("40 KB lines", { persisted: { complete: persisted.complete, outOfOrder: persisted.outOfOrder, bodyChars: persisted.bodyChars }, rpc: measured.rpc, rssMaxMiB: Math.round(measured.rss.maxBytes / MIB), pipeline: measured.pipeline });
    wide = { box, persisted, measured };
    return wide;
  }

  test("40 KB lines are stored once each, truncated to 16 Ki characters", async () => {
    const { persisted, measured } = await wideFlood();
    expect(persisted.complete).toBe(true);
    expect(persisted.outOfOrder).toBe(0);
    expect(persisted.bodyChars).toEqual({ min: MAX_LINE_CHARS, max: MAX_LINE_CHARS });
    expect(measured.rpc.p99).toBeLessThan(RPC_P99_MS);
    expect(measured.rss.maxBytes).toBeLessThan(RSS_MAX_BYTES);
  }, 300_000);

  test("devctl logs --all lists a ring of 40 KB lines within the memory budget", async () => {
    const { box } = await wideFlood();
    const probe = box.driver<ProbeResult>("probe.ts", ["--duration-ms", "20000"], { timeoutMs: 60_000 });
    await Bun.sleep(500);
    const listed = await box.verifyListed("flood", WIDE_COUNT);
    const measured = await probe;
    const oomKills = (await box.sh("grep '^oom_kill ' /sys/fs/cgroup/memory.events || true")).stdout.trim();
    report("40 KB lines, devctl logs --all", { listed: { records: listed.records, contiguousTail: listed.contiguousTail }, daemonRssMaxMiB: Math.round(measured.rss.maxBytes / MIB), oomKills });
    expect(listed.contiguousTail).toBe(true);
    expect(measured.rss.maxBytes).toBeLessThan(RSS_MAX_BYTES);
    expect(oomKills).toBe("oom_kill 0");
  }, 300_000);

  test("history pages back past a byte-bounded ring without gaps", async () => {
    const box = await container();
    const count = 150_000;
    await box.configure(`${CONFIG_HEADER}project:\n  name: soak-history\nlogs:\n  max_memory_bytes: ${4 * MIB}\nservices:\n${floodService("flood", 15_000, count)}`);
    await box.devctl(["start", "flood"]);
    await box.waitDone("flood");
    const status = await box.status();
    const paged = await box.driver<PageResult>("page.ts", ["--service", "flood", "--name", "flood", "--count", String(count), "--limit", "5000"], { timeoutMs: 300_000 });
    report("history paging", { ringRecords: status.logs.total, pages: paged.pages, emptyPages: paged.emptyPages, stalledAtEnd: paged.stalledAtEnd, pageMs: paged.pageMs, records: paged.records, first: paged.first, last: paged.last, contiguousTail: paged.contiguousTail, outOfOrder: paged.outOfOrder });
    await box.devctl(["down"], { allowFail: true });

    // Paging reached well below what the ring holds, and every page joined the next.
    expect(paged.records).toBeGreaterThan(status.logs.total * 2);
    expect(paged.records).toBeGreaterThan(49_000);
    expect(paged.contiguousTail).toBe(true);
    expect(paged.outOfOrder).toBe(0);
    expect(paged.stalledAtEnd).toBe(false);
  }, 300_000);
});
