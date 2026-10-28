// Version skew: a client and a daemon from different builds, as happens when
// devctl is upgraded while a daemon keeps running. The old build is main
// (or DEVCTL_SOAK_OLD_REF), compiled by the harness.
//
// Either way round, the client must keep working against the daemon it finds,
// must not replace or kill it, and must be able to stop it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CONFIG_HEADER, floodService, IMAGE_BUILD_TIMEOUT_MS, oldDevctl, report, SoakContainer, soakEnabled, soakImage, soakQuick, type DaemonStatus, type OldDevctl } from "../harness/soak.ts";

const RUNNING = /^(RUNNING|HEALTHY)$/;
const CONFIG = `${CONFIG_HEADER}project:\n  name: soak-skew\nservices:\n${floodService("tick", 20, 1_000_000)}`;

describe.skipIf(!soakEnabled || soakQuick)("version skew", () => {
  let tag = "";
  let old: OldDevctl | undefined;
  const containers: SoakContainer[] = [];

  beforeAll(async () => {
    tag = await soakImage();
    old = await oldDevctl();
  }, IMAGE_BUILD_TIMEOUT_MS * 2);

  afterAll(async () => {
    await Promise.all(containers.map((container) => container.rm()));
  });

  // A container with both builds: `devctl` is this checkout, `devctl-old` the old ref.
  async function both(): Promise<SoakContainer> {
    if (old === undefined) {
      throw new Error("no old ref to build: fetch main, or set DEVCTL_SOAK_OLD_REF");
    }
    const box = await SoakContainer.start(tag);
    containers.push(box);
    await box.install(old.path, "/usr/local/bin/devctl-old");
    await box.configure(CONFIG);
    return box;
  }

  async function tickLines(box: SoakContainer, bin: string): Promise<number> {
    const out = await box.exec([bin, "logs", "tick", "--json"], { allowFail: true });
    return out.stdout.split("\n").filter((line) => line.includes("tick seq=")).length;
  }

  test("an old client drives a daemon from this build", async () => {
    const box = await both();
    await box.devctl(["start", "tick"]);
    const daemon = await box.daemonPid();
    await Bun.sleep(2_000);
    const status = await box.exec(["devctl-old", "status", "--json"], { allowFail: true });
    const seen = status.code === 0 ? (JSON.parse(status.stdout) as DaemonStatus).services.tick?.state : undefined;
    const lines = await tickLines(box, "devctl-old");
    const stop = await box.exec(["devctl-old", "stop", "tick"], { allowFail: true });
    const stopped = (await box.status()).services.tick?.state;
    const start = await box.exec(["devctl-old", "start", "tick"], { allowFail: true });
    const restarted = (await box.status()).services.tick?.state;
    const daemonAfter = await box.daemonPid();
    const down = await box.exec(["devctl-old", "down"], { allowFail: true });
    const after = await box.devctl(["status"], { allowFail: true });
    report("old client, new daemon", {
      old: old?.version,
      ref: old?.ref,
      status: { code: status.code, state: seen, notice: status.stderr.trim().slice(0, 200) },
      lines,
      stop: stop.code,
      stopped,
      start: start.code,
      restarted,
      sameDaemon: daemonAfter === daemon,
      down: { code: down.code, out: down.stdout.trim().slice(0, 120) },
      after: after.stdout.trim().slice(0, 80),
    });

    expect(status.code).toBe(0);
    expect(seen).toMatch(RUNNING);
    expect(lines).toBeGreaterThan(0);
    expect(stop.code).toBe(0);
    expect(stopped).toBe("STOPPED");
    expect(start.code).toBe(0);
    expect(restarted).toMatch(RUNNING);
    expect(daemonAfter).toBe(daemon);
    expect(down.code).toBe(0);
    expect(after.stdout).toContain("supervisor is not running");
  }, 300_000);

  test("a client from this build drives an old daemon", async () => {
    const box = await both();
    await box.exec(["devctl-old", "start", "tick"]);
    const daemon = await box.daemonPid();
    await Bun.sleep(2_000);
    const status = await box.devctl(["status", "--json"], { allowFail: true });
    const seen = status.code === 0 ? (JSON.parse(status.stdout) as DaemonStatus).services.tick?.state : undefined;
    const lines = await tickLines(box, "devctl");
    const stop = await box.devctl(["stop", "tick"], { allowFail: true });
    const start = await box.devctl(["start", "tick"], { allowFail: true });
    const restarted = await box.exec(["devctl-old", "status", "--json"], { allowFail: true });
    const restartedState = restarted.code === 0 ? (JSON.parse(restarted.stdout) as DaemonStatus).services.tick?.state : undefined;
    const daemonAfter = await box.daemonPid();
    const down = await box.devctl(["down"], { allowFail: true });
    const gone = (await box.sh(`kill -0 ${daemon} 2>/dev/null && cat /proc/${daemon}/stat | cut -d' ' -f3 || echo gone`)).stdout.trim();
    // The upgrade path: the next start runs a daemon from this build.
    await box.devctl(["start", "tick"]);
    const upgraded = await box.status();
    report("new client, old daemon", {
      old: old?.version,
      status: { code: status.code, state: seen, notice: status.stderr.trim().slice(0, 200) },
      lines,
      stop: { code: stop.code, err: stop.stderr.trim().slice(0, 160) },
      start: { code: start.code, err: start.stderr.trim().slice(0, 160) },
      restartedState,
      sameDaemon: daemonAfter === daemon,
      down: { code: down.code, out: down.stdout.trim().slice(0, 120) },
      oldDaemonAfterDown: gone,
      upgraded: { state: upgraded.services.tick?.state, logStore: upgraded.daemon?.logStore, watchdog: upgraded.daemon?.watchdog },
    });
    await box.devctl(["down"], { allowFail: true });

    expect(status.code).toBe(0);
    expect(seen).toMatch(RUNNING);
    expect(lines).toBeGreaterThan(0);
    expect(stop.code).toBe(0);
    expect(start.code).toBe(0);
    expect(restartedState).toMatch(RUNNING);
    expect(daemonAfter).toBe(daemon);
    expect(down.code).toBe(0);
    // Stopped: gone, or a zombie nobody reaps under PID 1 `sleep infinity`.
    expect(gone).toMatch(/^(gone|Z)$/);
    expect(upgraded.services.tick?.state).toMatch(RUNNING);
    expect(upgraded.daemon?.logStore).toBe("worker");
  }, 300_000);
});
