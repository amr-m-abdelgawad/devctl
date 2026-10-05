// A long mixed session: steady output, long lines, a service restarted every
// few seconds, LLM calls through the proxy, and a user paging and searching
// the logs. What a flood does in a minute a leak does in a day, so this
// watches levels over time instead of peaks: memory, descriptors, threads,
// zombies and FIFOs must settle and stay.
//
// DEVCTL_SOAK_ENDURANCE_MIN sets its length (15 minutes when unset). Two more
// knobs are for finding where a climb comes from, not for the nightly run:
// DEVCTL_SOAK_ENDURANCE_ONLY runs only the named steps of the loop
// ("restart", "llm calls", "page", "search", "status", "whole window",
// comma-separated, "" for none), and DEVCTL_SOAK_ENDURANCE_RATE scales both
// floods (0 for none).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CONFIG_HEADER, floodService, IMAGE_BUILD_TIMEOUT_MS, MIB, report, SoakContainer, soakEnabled, soakImage, soakQuick } from "../harness/soak.ts";

type Sample = { atS: number; pid: number; rssMiB: number; anonMiB: number; fileMiB: number; workingSetMiB: number; fds: number; threads: number; zombies: number; daemonZombies: number; fifos: number };

const MINUTES = Number(process.env.DEVCTL_SOAK_ENDURANCE_MIN ?? "15");
const ONLY = process.env.DEVCTL_SOAK_ENDURANCE_ONLY?.split(",");
const DURATION_MS = MINUTES * 60_000;
const SECONDS = MINUTES * 60;
const PROXY_PORT = 18080;
const RATE = Number(process.env.DEVCTL_SOAK_ENDURANCE_RATE ?? "1");
const STEADY_RATE = Math.round(1_500 * RATE);
const WIDE_RATE = Math.round(100 * RATE);
// Small caps, so the session files, the ring and the capture stores all reach
// their limits early and spend the rest of the run evicting.
const SESSION_CAP = 64 * MIB;
const CAPTURE_CAP = 8 * MIB;
// Less than the window's bytes, so part of the window is always read from the session files.
const RING_BYTES = 8 * MIB;
const RSS_MAX_MIB = 400;

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;
}

// Least-squares slope of `value` over time, per hour.
function perHour(samples: Sample[], value: (sample: Sample) => number): number {
  const n = samples.length;
  const meanX = samples.reduce((sum, s) => sum + s.atS, 0) / n;
  const meanY = samples.reduce((sum, s) => sum + value(s), 0) / n;
  const cov = samples.reduce((sum, s) => sum + (s.atS - meanX) * (value(s) - meanY), 0);
  const variance = samples.reduce((sum, s) => sum + (s.atS - meanX) ** 2, 0);
  return variance === 0 ? 0 : Math.round((cov / variance) * 3600 * 10) / 10;
}

describe.skipIf(!soakEnabled || soakQuick)("endurance", () => {
  let tag = "";
  const containers: SoakContainer[] = [];

  beforeAll(async () => {
    tag = await soakImage();
  }, IMAGE_BUILD_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all(containers.map((container) => container.rm()));
  });

  test(`a ${MINUTES} minute mixed session settles and stays level`, async () => {
    const box = await SoakContainer.start(tag);
    containers.push(box);
    const quiet = Array.from({ length: 6 }, (_, index) => `  quiet-${index}:\n    command: [sleep, "36000"]\n`).join("");
    await box.configure(`${CONFIG_HEADER}project:
  name: soak-endurance
logs:
  max_memory_bytes: ${RING_BYTES}
  persistence:
    max_session_bytes: ${SESSION_CAP}
proxy:
  enabled: true
  listen: { host: 127.0.0.1, port: ${PROXY_PORT} }
  inspect_store_max_bytes: ${CAPTURE_CAP}
  routes:
    - name: llm-route
      match: { path: /v1 }
      upstream: { service: llm }
llm:
  enabled: true
  store_max_bytes: ${CAPTURE_CAP}
  sources:
    - name: local-llm
      type: proxy
      via: { route: llm-route }
services:
  llm:
    command: [bun, /soak/driver/llm-upstream.ts, "18082", --completion-bytes, "16384"]
    ports: { http: 18082 }
    health: { type: http, url: "http://127.0.0.1:\${services.llm.ports.http}/health", interval_seconds: 2 }
  churn:
    command: "echo churn up $$; sleep 36000"
    shell: true
    logs: { stdout: true, stderr: true, dedupe_access_line: true }
${quiet}${RATE > 0 ? floodService("steady", STEADY_RATE, STEADY_RATE * (SECONDS + 120)) + floodService("wide", WIDE_RATE, WIDE_RATE * (SECONDS + 120), { width: 4_096 }) : ""}`);
    await box.devctl(["start", "llm", "--wait", "--timeout", "60s"], { timeoutMs: 120_000 });
    await box.devctl(["start", "churn", ...(RATE > 0 ? ["steady", "wide"] : []), ...Array.from({ length: 6 }, (_, index) => `quiet-${index}`)], { timeoutMs: 120_000 });

    const floodsStartedAt = Date.now();
    const watch = box.driver<{ samples: Sample[] }>("watch-daemon.ts", ["--duration-ms", String(DURATION_MS), "--interval-ms", "10000"], { timeoutMs: DURATION_MS + 120_000 });
    // What a person at the TUI and their tools do, round after round.
    const until = Date.now() + DURATION_MS;
    let rounds = 0;
    const failed: Record<string, number> = {};
    let lastFailure = "";
    while (Date.now() < until) {
      // One at a time, as one person would.
      const steps: Array<[string, () => ReturnType<SoakContainer["sh"]>]> = [
        ["restart", () => box.devctl(["restart", "churn"], { allowFail: true, timeoutMs: 60_000 })],
        ["llm calls", () => box.exec(["bun", "/soak/driver/llm-load.ts", "--url", `http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, "--count", "8", "--prompt-bytes", "65536"], { allowFail: true, timeoutMs: 120_000 })],
        ["page", () => box.sh("devctl logs wide --json > /dev/null", { allowFail: true, timeoutMs: 60_000 })],
        // A line written about twenty seconds ago: still in the window, no longer in memory.
        ["search", () => box.sh(`devctl logs steady --search "seq=${Math.max(1, Math.floor(((Date.now() - floodsStartedAt) / 1000 - 20) * STEADY_RATE))} " --json > /dev/null`, { allowFail: true, timeoutMs: 60_000 })],
        ["status", () => box.sh("devctl status --json > /dev/null", { allowFail: true, timeoutMs: 60_000 })],
      ];
      if (rounds % 10 === 9) {
        // Now and then, the whole window of the long lines, a page at a time.
        steps.push(["whole window", () => box.sh("devctl logs wide --all --json > /dev/null", { allowFail: true, timeoutMs: 120_000 })]);
      }
      for (const [name, step] of steps) {
        if (ONLY !== undefined && !ONLY.includes(name)) {
          continue;
        }
        const result = await step();
        if (result.code !== 0) {
          failed[name] = (failed[name] ?? 0) + 1;
          lastFailure = `${name}: exit ${result.code} ${`${result.stdout}${result.stderr}`.trim().slice(-300)}`;
        }
      }
      rounds += 1;
      await Bun.sleep(2_000);
    }
    const failures = Object.values(failed).reduce((sum, count) => sum + count, 0);
    const { samples } = await watch;
    const status = await box.status();
    const sessionBytes = Number((await box.sh(`du -sb /work/home/logs/session-${status.session_id} | cut -f1`)).stdout.trim());
    const spoolBytes = Number((await box.sh('du -sb "$DEVCTL_HOME"/state/*/log-spool 2>/dev/null | cut -f1 || echo 0')).stdout.trim() || "0");
    await box.devctl(["down"], { allowFail: true });

    // The first 40% is warm-up: the ring, the session files and the capture stores fill to their caps.
    const settled = samples.filter((sample) => sample.atS >= SECONDS * 0.4);
    const middle = settled.filter((sample) => sample.atS < SECONDS * 0.7);
    const late = settled.filter((sample) => sample.atS >= SECONDS * 0.7);
    const level = (part: Sample[], value: (sample: Sample) => number): number => median(part.map(value));
    const numbers = {
      minutes: MINUTES,
      rounds,
      failed,
      lastFailure,
      samples: samples.length,
      daemonRestarts: new Set(samples.map((sample) => sample.pid)).size - 1,
      rssMiB: { max: Math.max(...samples.map((s) => s.rssMiB)), middle: level(middle, (s) => s.rssMiB), late: level(late, (s) => s.rssMiB), perHour: perHour(settled, (s) => s.rssMiB) },
      // The process's own pages, without the pages of files it has mapped.
      anonMiB: { middle: level(middle, (s) => s.anonMiB), late: level(late, (s) => s.anonMiB), perHour: perHour(settled, (s) => s.anonMiB) },
      workingSetMiB: { max: Math.max(...samples.map((s) => s.workingSetMiB)), middle: level(middle, (s) => s.workingSetMiB), late: level(late, (s) => s.workingSetMiB), perHour: perHour(settled, (s) => s.workingSetMiB) },
      fds: { middle: level(middle, (s) => s.fds), late: level(late, (s) => s.fds), max: Math.max(...settled.map((s) => s.fds)) },
      threads: { middle: level(middle, (s) => s.threads), late: level(late, (s) => s.threads) },
      // PID 1 here is `sleep infinity`, which reaps nothing: every restart of the shell-wrapped service orphans a dead child.
      zombies: { max: Math.max(...samples.map((s) => s.zombies)), last: samples.at(-1)?.zombies },
      fifos: { middle: level(middle, (s) => s.fifos), late: level(late, (s) => s.fifos), max: Math.max(...samples.map((s) => s.fifos)) },
      sessionMiB: Math.round(sessionBytes / MIB),
      spoolMiB: Math.round(spoolBytes / MIB),
      logs: status.logs,
      daemon: status.daemon,
    };
    report("endurance", numbers);
    console.log(`[soak] endurance series ${JSON.stringify(samples.map((s) => [s.atS, s.rssMiB, s.workingSetMiB, s.fds, s.threads, s.zombies, s.daemonZombies, s.fifos, s.anonMiB, s.fileMiB]))}`);

    expect(numbers.daemonRestarts).toBe(0);
    expect(rounds).toBeGreaterThan(MINUTES * 2);
    expect(failures).toBeLessThan(rounds / 10);
    expect(numbers.rssMiB.max).toBeLessThan(RSS_MAX_MIB);
    // Level, not peak: the last third against the third before it. The
    // runtime's own footprint still creeps under this load, 6 to 9 MiB between
    // the two thirds in runs of 30 to 105 minutes; a store that grows without
    // a bound shows as several times that.
    expect(numbers.rssMiB.late - numbers.rssMiB.middle).toBeLessThan(25);
    expect(numbers.fds.late - numbers.fds.middle).toBeLessThan(12);
    expect(numbers.threads.late - numbers.threads.middle).toBeLessThan(4);
    expect(numbers.fifos.late).toBe(numbers.fifos.middle);
    // The daemon reaps those orphans a few seconds after each restart, so they never add up.
    expect(numbers.zombies.max).toBeLessThan(8);
    expect(sessionBytes).toBeLessThan(SESSION_CAP * 1.25);
    expect(status.daemon?.logs?.loss ?? 0).toBe(0);
  }, DURATION_MS + 15 * 60_000);
});
