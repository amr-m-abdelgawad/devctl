// Quiet services: what a stack that prints nothing costs the daemon, and how
// soon a line written after a quiet spell is read.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CONFIG_HEADER, floodService, IMAGE_BUILD_TIMEOUT_MS, report, SoakContainer, soakEnabled, soakImage } from "../harness/soak.ts";

type IdleCost = { pid: number; seconds: number; cpuPercent: number; mainThreadCpuPercent: number; mainThreadRunsPerSecond: number };

const QUIET_SERVICES = 30;
const TICKS = 80;

describe.skipIf(!soakEnabled)("quiet", () => {
  let tag = "";
  const containers: SoakContainer[] = [];

  beforeAll(async () => {
    tag = await soakImage();
  }, IMAGE_BUILD_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all(containers.map((container) => container.rm()));
  });

  test("quiet services do not keep the daemon awake, and a line after a quiet spell is read at once", async () => {
    const box = await SoakContainer.start(tag);
    containers.push(box);
    const names = Array.from({ length: QUIET_SERVICES }, (_, index) => `quiet-${index}`);
    const quiet = names.map((name) => `  ${name}:\n    command: [sleep, "3600"]\n`).join("");
    // Four lines a second: every line follows a quarter of a second of silence.
    await box.configure(`${CONFIG_HEADER}project:\n  name: soak-quiet\nservices:\n${quiet}${floodService("tick", 4, TICKS)}`);
    await box.devctl(["start", ...names], { timeoutMs: 120_000 });
    await Bun.sleep(3_000);
    const cost = await box.driver<IdleCost>("idle.ts", ["--duration-ms", "15000"], { timeoutMs: 60_000 });
    await box.devctl(["start", "tick"]);
    await box.waitDone("tick", { timeoutMs: 120_000 });
    const status = await box.status();
    const persisted = await box.verifySessions([status.session_id], "tick", TICKS);
    report("quiet services", { services: QUIET_SERVICES, daemon: cost, tick: { complete: persisted.complete, lagMs: persisted.lagMs } });
    await box.devctl(["down"], { allowFail: true });

    expect(persisted.complete).toBe(true);
    // A reader left to its 100 ms check reads such a line tens of milliseconds late at the median.
    expect(persisted.lagMs.p50).toBeLessThan(15);
    // About 1% of a core here. A reader that spun instead of sleeping would take a whole one.
    expect(cost.mainThreadCpuPercent).toBeLessThan(10);
  }, 300_000);
});
