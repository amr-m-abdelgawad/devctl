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

  test("down --keep-services mid-flood hands the service over with no line lost", async () => {
    const box = await container();
    const count = 100_000;
    await box.configure(`${CONFIG_HEADER}project:\n  name: soak-keep\nservices:\n${floodService("flood", 5_000, count)}`);
    await box.devctl(["start", "flood"]);
    const before = await box.status();
    await Bun.sleep(6_000);
    await box.devctl(["down", "--keep-services"]);
    // No daemon runs for five seconds; the drainer holds what the service writes meanwhile.
    await Bun.sleep(5_000);
    const aliveAfterDown = (await box.sh(`kill -0 ${before.services.flood!.pid}`, { allowFail: true })).code === 0;
    const drained = Number((await box.sh('ls "$DEVCTL_HOME"/state/*/stdio/drain/ 2>/dev/null | grep -c spool || true')).stdout.trim());
    await box.devctl(["start", "flood"]);
    const after = await box.status();
    await box.waitDone("flood", { timeoutMs: 120_000 });
    const s1 = await box.verifySessions([before.session_id], "flood", count);
    const s2 = await box.verifySessions([after.session_id], "flood", count);
    const union = await box.verifySessions([before.session_id, after.session_id], "flood", count);
    report("down --keep-services mid-flood", {
      aliveAfterDown,
      pidAfterTakeover: after.services.flood?.pid,
      drainSegments: drained,
      s1: { first: s1.first, last: s1.last, records: s1.records },
      s2: { first: s2.first, last: s2.last, records: s2.records, lagMs: s2.lagMs },
      union: { complete: union.complete, missing: union.missingInside, duplicates: union.duplicates, outOfOrder: union.outOfOrder },
    });
    await box.devctl(["down"], { allowFail: true });

    expect(aliveAfterDown).toBe(true);
    expect(after.services.flood?.pid).toBe(before.services.flood!.pid);
    expect(drained).toBeGreaterThan(0);
    // Unlike a SIGKILL, a stop flushes what it read: both sessions together hold every line once.
    expect(union.complete).toBe(true);
    expect(union.missingInside).toBe(0);
    expect(union.duplicates).toBe(0);
    expect(union.outOfOrder).toBe(0);
    expect(s2.lagMs.max).toBeLessThan(RESUMED_LAG_MAX_MS);
  }, 300_000);

  // What `devctl doctor` says about PID 1, and whether the daemon says it is reaping.
  async function reaping(box: SoakContainer): Promise<{ doctor: string; reaper: string | undefined; nonReapingPid1: boolean }> {
    const doctor = (await box.devctl(["doctor"], { allowFail: true })).stdout;
    const daemon = (await box.status()).daemon as { orphanReaper?: string; nonReapingPid1?: boolean } | undefined;
    return { doctor, reaper: daemon?.orphanReaper, nonReapingPid1: daemon?.nonReapingPid1 ?? false };
  }

  test("under PID 1 sleep infinity the daemon reaps a running service's orphans without being asked", async () => {
    const box = await container();
    await box.configure(`${CONFIG_HEADER}project:\n  name: soak-zombies\nservices:\n${ORPHANS}`);
    await box.devctl(["start", "orphans"]);
    const zombies = await box.driver<Zombies>("zombies.ts", ["--duration-ms", "20000"], { timeoutMs: 60_000 });
    const state = await reaping(box);
    report("zombies, PID 1 sleep infinity, default config", { zombies, reaper: state.reaper, nonReapingPid1: state.nonReapingPid1 });
    await box.devctl(["down"], { allowFail: true });

    // About 40 orphans a second exit; the reaper looks every second while there are any.
    expect(zombies.max).toBeLessThan(200);
    expect(zombies.last).toBeLessThan(200);
    expect(state.reaper).toBe("on");
    expect(state.nonReapingPid1).toBe(true);
    // Doctor prints a passing check as its name alone.
    expect(state.doctor).toContain("✓ container init");
  }, 120_000);

  test("restarting and stopping a shell-wrapped service leaves no zombie behind", async () => {
    const box = await container();
    // The shell dies with its child, before it can collect it: the child is orphaned dead.
    await box.configure(`${CONFIG_HEADER}project:\n  name: soak-restarts\nservices:\n  wrapped:\n    command: "echo up $$; sleep 36000"\n    shell: true\n`);
    await box.devctl(["start", "wrapped"]);
    const restarts = 15;
    for (let i = 0; i < restarts; i += 1) {
      await box.devctl(["restart", "wrapped"], { timeoutMs: 60_000 });
    }
    await box.devctl(["stop", "wrapped"], { timeoutMs: 60_000 });
    // A dead child is collected once it has stayed dead for three looks, a second apart, the first within five.
    const zombies = await box.driver<Zombies>("zombies.ts", ["--duration-ms", "12000"], { timeoutMs: 60_000 });
    report("zombies after restarts", { restarts, zombies });
    await box.devctl(["down"], { allowFail: true });

    expect(zombies.last).toBe(0);
  }, 180_000);

  test("under Docker's init the daemon leaves reaping to it", async () => {
    const box = await container({ init: true });
    await box.configure(`${CONFIG_HEADER}project:\n  name: soak-zombies-init\nservices:\n${ORPHANS}`);
    await box.devctl(["start", "orphans"]);
    const zombies = await box.driver<Zombies>("zombies.ts", ["--duration-ms", "20000"], { timeoutMs: 60_000 });
    const state = await reaping(box);
    report("zombies, Docker init", { zombies, reaper: state.reaper, nonReapingPid1: state.nonReapingPid1 });
    await box.devctl(["down"], { allowFail: true });

    expect(zombies.max).toBeLessThan(200);
    expect(state.reaper).toBeUndefined();
    expect(state.nonReapingPid1).toBe(false);
    expect(state.doctor).not.toContain("container init");
  }, 120_000);

  test("with reap_orphans turned off, zombies pile up under PID 1 sleep infinity and doctor says why", async () => {
    const box = await container();
    await box.configure(`${CONFIG_HEADER}project:\n  name: soak-zombies-off\nsupervisor:\n  reap_orphans: false\nservices:\n${ORPHANS}`);
    await box.devctl(["start", "orphans"]);
    const zombies = await box.driver<Zombies>("zombies.ts", ["--duration-ms", "20000"], { timeoutMs: 60_000 });
    const state = await reaping(box);
    report("zombies, PID 1 sleep infinity, reap_orphans off", { zombies, reaper: state.reaper });
    await box.devctl(["down"], { allowFail: true });

    // The control for the cases above: the generator does make zombies.
    expect(zombies.last).toBeGreaterThan(400);
    expect(state.reaper).toBeUndefined();
    expect(state.doctor).toContain("container init");
    expect(state.doctor).toContain("supervisor.reap_orphans is false");
  }, 120_000);
});
