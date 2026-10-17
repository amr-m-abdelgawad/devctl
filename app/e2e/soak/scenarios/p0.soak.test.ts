// The P0 blockers of the ingest rewrite, each reproduced in a dev-container
// shaped container against the compiled binary.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CONFIG_HEADER,
  floodService,
  IMAGE_BUILD_TIMEOUT_MS,
  MIB,
  report,
  SoakContainer,
  soakEnabled,
  soakImage,
  soakQuick,
  type ProbeResult,
} from "../harness/soak.ts";

const RPC_P99_MS = 50;
const RSS_MAX_BYTES = 400_000_000;
const IDLE = `  idle:
    command: [sleep, "3600"]
`;

type Records = { exists: boolean; records: { seq: number; body: unknown; timestamp: string }[]; manifest?: { closedAt?: string } };

describe.skipIf(!soakEnabled)("P0 repros", () => {
  let tag = "";
  const containers: SoakContainer[] = [];

  beforeAll(async () => {
    tag = await soakImage();
  }, IMAGE_BUILD_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all(containers.map((container) => container.rm()));
  });

  async function container(shape: { init?: boolean } = {}): Promise<SoakContainer> {
    const started = await SoakContainer.start(tag, shape);
    containers.push(started);
    return started;
  }

  test("a stale restart.request does not stop the daemon that finds it", async () => {
    const box = await container();
    await box.configure(`${CONFIG_HEADER}project:\n  name: soak-restart\nservices:\n${IDLE}`);
    await box.devctl(["start", "idle"]);
    const state = await box.stateDir();
    const first = await box.daemonPid();
    const firstSession = (await box.status()).session_id;
    await box.devctl(["down"]);
    // Left behind for the daemon that just stopped.
    await box.write(`${state}/restart.request`, `${JSON.stringify({ requestedAtMs: Date.now() - 60_000, pid: first, session: firstSession })}\n`);
    await box.devctl(["start", "idle"]);
    const second = await box.daemonPid();
    await Bun.sleep(6_000);
    const afterStart = { pid: await box.daemonPid(), request: (await box.sh(`test -e ${state}/restart.request && echo present || echo gone`)).stdout.trim() };
    // Written while it runs, for another daemon, and with no target at all.
    await box.write(`${state}/restart.request`, `${JSON.stringify({ requestedAtMs: Date.now(), pid: first, session: firstSession })}\n`);
    await Bun.sleep(4_000);
    const afterOther = { pid: await box.daemonPid(), request: (await box.sh(`test -e ${state}/restart.request && echo present || echo gone`)).stdout.trim() };
    await box.write(`${state}/restart.request`, `${JSON.stringify({ requestedAtMs: Date.now() })}\n`);
    await Bun.sleep(4_000);
    const afterUntargeted = { pid: await box.daemonPid(), request: (await box.sh(`test -e ${state}/restart.request && echo present || echo gone`)).stdout.trim() };
    const status = await box.status();
    report("stale restart.request", { first, second, afterStart, afterOther, afterUntargeted, idle: status.services.idle?.state });
    await box.devctl(["down"], { allowFail: true });

    expect(second).not.toBe(first);
    expect(afterStart).toEqual({ pid: second, request: "gone" });
    expect(afterOther).toEqual({ pid: second, request: "gone" });
    expect(afterUntargeted).toEqual({ pid: second, request: "gone" });
    expect(status.services.idle?.state).toMatch(/^(RUNNING|HEALTHY)$/);
  }, 120_000);

  test("a crash-left spool is replayed into the dead session with its read times", async () => {
    const box = await container();
    await box.configure(`${CONFIG_HEADER}project:\n  name: soak-replay\nservices:\n${IDLE}`);
    await box.devctl(["start", "idle"]);
    const state = await box.stateDir();
    await box.devctl(["down"]);
    const dead = "2026-09-30T00-00-00Z-dead01";
    const at = Date.now() - 60_000;
    await box.driver("spool-craft.ts", ["--spool-root", `${state}/log-spool`, "--logs-root", "/work/home/logs", "--session", dead, "--service", "api", "--pid", "4242", "--at", String(at)]);
    await box.devctl(["start", "idle"]);
    const live = (await box.status()).session_id;
    let replayed: Records = { exists: false, records: [] };
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && replayed.records.length < 6) {
      await Bun.sleep(500);
      replayed = await box.driver<Records>("records.ts", ["--session-dir", `/work/home/logs/session-${dead}`, "--service", "api"]);
    }
    const spoolLeft = (await box.sh(`ls ${state}/log-spool | grep -c dead01 || true`)).stdout.trim();
    const inLive = await box.driver<Records>("records.ts", ["--session-dir", `/work/home/logs/session-${live}`, "--service", "api"]);
    report("crash-left spool", { records: replayed.records.map((row) => [row.seq, row.body, row.timestamp]), closedAt: replayed.manifest?.closedAt, spoolLeft, inLive: inLive.records.length });
    await box.devctl(["down"], { allowFail: true });

    expect(replayed.records.map((row) => [row.seq, row.body])).toEqual([
      [1, "before crash 1"],
      [2, "before crash 2"],
      [3, "before crash 3"],
      [4, "replayed 1"],
      [5, "replayed 2"],
      [6, "replayed 3 with no newline"],
    ]);
    expect(replayed.records.slice(3).map((row) => row.timestamp)).toEqual([
      new Date(at).toISOString(),
      new Date(at).toISOString(),
      new Date(at + 250).toISOString(),
    ]);
    expect(typeof replayed.manifest?.closedAt).toBe("string");
    expect(spoolLeft).toBe("0");
    expect(inLive.records.length).toBe(0);
  }, 120_000);

  test.skipIf(soakQuick)("the session cap keeps the newest lines and never pauses ingest", async () => {
    const box = await container();
    const count = 300_000;
    const rate = 20_000;
    const cap = 8 * MIB;
    await box.configure(`${CONFIG_HEADER}project:\n  name: soak-cap\nlogs:\n  persistence:\n    max_session_bytes: ${cap}\nservices:\n${floodService("flood", rate, count)}`);
    await box.devctl(["start", "flood"]);
    const probe = await box.driver<ProbeResult>("probe.ts", ["--duration-ms", String((count / rate) * 1000 + 5_000)], { timeoutMs: 120_000 });
    await box.waitDone("flood");
    const session = (await box.status()).session_id;
    const bytes = Number((await box.sh(`cat /work/home/logs/session-${session}/flood*.jsonl | wc -c`)).stdout.trim());
    const persisted = await box.verifySessions([session], "flood", count);
    const listed = await box.verifyListed("flood", count);
    const elapsed = await box.floodElapsedMs("flood");
    report("session cap", { capMiB: cap / MIB, persistedMiB: Math.round((bytes / MIB) * 10) / 10, persisted: { records: persisted.records, first: persisted.first, last: persisted.last, contiguousTail: persisted.contiguousTail, outOfOrder: persisted.outOfOrder, parts: persisted.files.length }, listedTail: listed.contiguousTail, elapsed, expectedMs: (count / rate) * 1000, rpc: probe.rpc, rssMaxMiB: Math.round(probe.rss.maxBytes / MIB), pipeline: probe.pipeline });
    await box.devctl(["down"], { allowFail: true });

    // Rotation drops whole parts (a part is an eighth of the cap), so the session stays near its cap.
    expect(bytes).toBeLessThanOrEqual(cap + cap / 8);
    expect(persisted.contiguousTail).toBe(true);
    expect(persisted.first).toBeGreaterThan(1);
    expect(persisted.outOfOrder).toBe(0);
    expect(listed.contiguousTail).toBe(true);
    expect(probe.pipeline.pausedSamples).toBe(0);
    expect(probe.pipeline.maxLoss).toBe(0);
    // The service was never slowed: its paced writes took as long as the pace says.
    expect(elapsed).toBeLessThan((count / rate) * 1000 * 1.2);
    expect(probe.rpc.p99).toBeLessThan(RPC_P99_MS);
    expect(probe.rss.maxBytes).toBeLessThan(RSS_MAX_BYTES);
  }, 300_000);

  test.skipIf(soakQuick)("two services spilling at once each keep their order", async () => {
    const box = await container();
    const count = 300_000;
    await box.configure(`${CONFIG_HEADER}project:\n  name: soak-interleave\nservices:\n${IDLE}${floodService("flood-a", 0, count)}${floodService("flood-b", 0, count, { stderr: true })}`);
    await box.devctl(["start", "idle"]);
    const probe = box.driver<ProbeResult>("probe.ts", ["--duration-ms", "30000"], { timeoutMs: 120_000 });
    await Bun.sleep(1_000);
    await box.devctl(["start", "flood-a", "flood-b"]);
    const measured = await probe;
    await box.waitDone("flood-a");
    await box.waitDone("flood-b");
    const session = (await box.status()).session_id;
    const a = await box.verifySessions([session], "flood-a", count);
    const b = await box.verifySessions([session], "flood-b", count);
    report("interleaved spill", { a: { complete: a.complete, outOfOrder: a.outOfOrder, missing: a.missingInside }, b: { complete: b.complete, outOfOrder: b.outOfOrder, missing: b.missingInside }, rpc: measured.rpc, rssMaxMiB: Math.round(measured.rss.maxBytes / MIB), pipeline: measured.pipeline });
    await box.devctl(["down"], { allowFail: true });

    expect(measured.pipeline.maxSpooledBytes).toBeGreaterThan(0);
    expect(a.complete).toBe(true);
    expect(a.outOfOrder).toBe(0);
    expect(b.complete).toBe(true);
    expect(b.outOfOrder).toBe(0);
    expect(measured.rpc.p99).toBeLessThan(RPC_P99_MS);
    expect(measured.rss.maxBytes).toBeLessThan(RSS_MAX_BYTES);
  }, 300_000);

  test.skipIf(soakQuick)("clients that stop reading during a flood do not grow the daemon", async () => {
    const box = await container();
    const count = 600_000;
    await box.configure(`${CONFIG_HEADER}project:\n  name: soak-stall\nservices:\n${IDLE}${floodService("flood", 0, count)}`);
    await box.devctl(["start", "idle"]);
    // A suspended TUI (log_batch.v1) and an old client (per-record events) that never read again.
    const probe = box.driver<ProbeResult>("probe.ts", ["--duration-ms", "40000", "--stall", "both"], { timeoutMs: 120_000 });
    await Bun.sleep(2_000);
    await box.devctl(["start", "flood"]);
    const measured = await probe;
    await box.waitDone("flood");
    const session = (await box.status()).session_id;
    const persisted = await box.verifySessions([session], "flood", count);
    report("non-reading clients", { rpc: measured.rpc, rssMaxMiB: Math.round(measured.rss.maxBytes / MIB), pipeline: measured.pipeline, persisted: { complete: persisted.complete, outOfOrder: persisted.outOfOrder } });
    await box.devctl(["down"], { allowFail: true });

    expect(measured.rss.maxBytes).toBeLessThan(RSS_MAX_BYTES);
    expect(measured.rpc.p99).toBeLessThan(RPC_P99_MS);
    expect(persisted.complete).toBe(true);
  }, 300_000);

  test.skipIf(soakQuick)("two repositories pruning one logs root never delete a live session", async () => {
    const box = await container();
    const shared = "/work/shared-logs";
    const persistence = `logs:\n  persistence:\n    directory: ${shared}\n    max_session_logs: 1\n    max_total_bytes: ${MIB}\n`;
    const count = 60_000;
    await box.configure(`${CONFIG_HEADER}project:\n  name: soak-prune-a\n${persistence}services:\n${floodService("flood", 2_000, count)}`, "/work/repo-a");
    await box.configure(`${CONFIG_HEADER}project:\n  name: soak-prune-b\n${persistence}services:\n${IDLE}`, "/work/repo-b");
    // Closed sessions from earlier days, for the pruners to find.
    for (let day = 1; day <= 5; day += 1) {
      const dir = `${shared}/session-2026-09-0${day}T00-00-00Z-old00${day}`;
      await box.sh(`mkdir -p ${dir} && head -c 400000 /dev/zero | tr '\\0' 'x' > ${dir}/svc.jsonl && echo jsonl > ${dir}/FORMAT && echo '{"repo":"","closedAt":"2026-09-0${day}T01:00:00.000Z"}' > ${dir}/manifest.json`, { cwd: "/work" });
    }
    await box.devctl(["start", "flood"], { cwd: "/work/repo-a" });
    const live = (await box.status("/work/repo-a")).session_id;
    const stateA = await box.stateDir();
    for (let round = 0; round < 3; round += 1) {
      await Bun.sleep(3_000);
      await box.devctl(["start", "idle"], { cwd: "/work/repo-b" });
      await Bun.sleep(1_000);
      await box.devctl(["down"], { cwd: "/work/repo-b" });
    }
    await box.waitDone("flood", { cwd: "/work/repo-a", stateDir: stateA });
    const survivors = (await box.sh(`ls ${shared}`, { cwd: "/work" })).stdout.trim().split("\n");
    const persisted = await box.verifySessions([live], "flood", count, shared);
    report("two repos pruning", { live, survivors, persisted: { complete: persisted.complete, outOfOrder: persisted.outOfOrder, missing: persisted.missingInside } });
    await box.devctl(["down"], { allowFail: true, cwd: "/work/repo-a" });

    expect(survivors).toContain(`session-${live}`);
    expect(survivors.filter((name) => name.includes("old00")).length).toBeLessThan(5);
    expect(persisted.complete).toBe(true);
    expect(persisted.outOfOrder).toBe(0);
  }, 300_000);
});
