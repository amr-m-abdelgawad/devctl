// What happens around the daemon: a SIGKILL mid-flood, and zombies when PID 1
// does not reap (`sleep infinity`, as many dev containers run).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gateEnabled, gatedName } from "../gates.ts";
import { CONFIG_HEADER, floodService, IMAGE_BUILD_TIMEOUT_MS, report, SoakContainer, soakEnabled, soakImage, soakQuick, type VerifyResult } from "../harness/soak.ts";

type Zombies = { max: number; last: number; samples: number; byParent: Record<string, number> };

// Lines written while no daemon ran must keep their read time, not the replay time.
const RESUMED_LAG_MAX_MS = 1_000;
const ORPHANS = `  orphans:
    command: "while true; do (sleep 0.05 &) ; sleep 0.02; done"
    shell: true
`;

describe.skipIf(!soakEnabled || soakQuick)("recovery", () => {
  let tag = "";
  const containers: SoakContainer[] = [];
  let killed: { s1: VerifyResult; s2: VerifyResult; union: VerifyResult } | undefined;

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

  async function sigkillMidFlood(): Promise<{ s1: VerifyResult; s2: VerifyResult; union: VerifyResult }> {
    if (killed !== undefined) {
      return killed;
    }
    const box = await container();
    const count = 100_000;
    await box.configure(`${CONFIG_HEADER}project:\n  name: soak-kill\nservices:\n${floodService("flood", 5_000, count)}`);
    await box.devctl(["start", "flood"]);
    const before = await box.status();
    const daemon = await box.daemonPid();
    await Bun.sleep(6_000);
    await box.sh(`kill -9 ${daemon}`);
    await Bun.sleep(5_000);
    const aliveAfterKill = (await box.sh(`kill -0 ${before.services.flood!.pid}`, { allowFail: true })).code === 0;
    const drained = Number((await box.sh('ls "$DEVCTL_HOME"/state/*/stdio/drain/ 2>/dev/null | grep -c spool || true')).stdout.trim());
    await box.devctl(["start", "flood"]);
    const after = await box.status();
    await box.waitDone("flood", { timeoutMs: 120_000 });
    const s1 = await box.verifySessions([before.session_id], "flood", count);
    const s2 = await box.verifySessions([after.session_id], "flood", count);
    const union = await box.verifySessions([before.session_id, after.session_id], "flood", count);
    report("daemon SIGKILL", {
      floodPid: before.services.flood!.pid,
      aliveAfterKill,
      pidAfterTakeover: after.services.flood?.pid,
      restarts: (after.services.flood as { restarts?: number } | undefined)?.restarts,
      drainSegments: drained,
      logStore: after.daemon?.logStore,
      s1: { first: s1.first, last: s1.last, records: s1.records },
      s2: { first: s2.first, last: s2.last, records: s2.records, lagMs: s2.lagMs },
      union: { complete: union.complete, missing: union.missingInside, missingSample: union.missingSample.slice(0, 3), duplicates: union.duplicates, outOfOrder: union.outOfOrder },
    });
    expect(aliveAfterKill).toBe(true);
    expect(after.services.flood?.pid).toBe(before.services.flood!.pid);
    await box.devctl(["down"], { allowFail: true });
    killed = { s1, s2, union };
    return killed;
  }

  test("after a daemon SIGKILL the service keeps running and its logs resume with read times", async () => {
    const { s1, s2, union } = await sigkillMidFlood();
    expect(s1.records).toBeGreaterThan(0);
    // The new daemon reads everything from the outage on, through to the end.
    expect(s2.contiguousTail).toBe(true);
    expect(s2.done).toBe(true);
    expect(s2.lagMs.max).toBeLessThan(RESUMED_LAG_MAX_MS);
    expect(union.duplicates).toBe(0);
    expect(union.outOfOrder).toBe(0);
  }, 300_000);

  test.skipIf(!gateEnabled("sigkill-boundary-loss"))(gatedName("sigkill-boundary-loss", "no line is lost at the SIGKILL boundary"), async () => {
    const { union } = await sigkillMidFlood();
    expect(union.missingInside).toBe(0);
    expect(union.complete).toBe(true);
  }, 300_000);

  for (const shape of [
    { name: "PID 1 sleep infinity with reap_orphans", init: false, reap: true },
    { name: "Docker init without reap_orphans", init: true, reap: false },
  ]) {
    test(`zombies do not accumulate under ${shape.name}`, async () => {
      const box = await container({ init: shape.init });
      await box.configure(`${CONFIG_HEADER}project:\n  name: soak-zombies\n${shape.reap ? "supervisor:\n  reap_orphans: true\n" : ""}services:\n${ORPHANS}`);
      await box.devctl(["start", "orphans"]);
      const zombies = await box.driver<Zombies>("zombies.ts", ["--duration-ms", "20000"], { timeoutMs: 60_000 });
      const doctor = await box.devctl(["doctor"], { allowFail: true });
      const warned = /container init/.test(doctor.stdout) && /PID 1 is/.test(doctor.stdout);
      const status = await box.status();
      report(`zombies, ${shape.name}`, { zombies, doctorWarnsInit: warned, nonReapingPid1: status.daemon?.nonReapingPid1 ?? false });
      await box.devctl(["down"], { allowFail: true });

      // About 40 orphans a second exit; the reaper runs every second.
      expect(zombies.max).toBeLessThan(200);
      expect(zombies.last).toBeLessThan(200);
      expect(warned).toBe(!shape.init);
      expect(status.daemon?.nonReapingPid1 ?? false).toBe(!shape.init);
    }, 120_000);
  }

  test("without an init or reap_orphans, zombies pile up and doctor says why", async () => {
    const box = await container();
    await box.configure(`${CONFIG_HEADER}project:\n  name: soak-zombies-off\nservices:\n${ORPHANS}`);
    await box.devctl(["start", "orphans"]);
    const zombies = await box.driver<Zombies>("zombies.ts", ["--duration-ms", "20000"], { timeoutMs: 60_000 });
    const doctor = await box.devctl(["doctor"], { allowFail: true });
    report("zombies, PID 1 sleep infinity without reap_orphans", { zombies, doctorWarnsInit: /container init/.test(doctor.stdout) });
    await box.devctl(["down"], { allowFail: true });

    // The control for the two cases above: the generator does make zombies.
    expect(zombies.last).toBeGreaterThan(400);
    expect(doctor.stdout).toContain("container init");
  }, 120_000);
});
