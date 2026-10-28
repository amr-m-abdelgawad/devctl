import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { OrphanReaper, type ReaperHost } from "./subreaper.ts";

const MODULE = fileURLToPath(new URL("./subreaper.ts", import.meta.url));

const SELF = 100;

type Child = { state: string; parent?: number; group?: number; start?: number };

// A process table the test edits between ticks. `reap` removes the child, as waitpid does.
function table(): { children: Map<number, Child>; reaped: number[]; scans: number; host: ReaperHost } {
  const children = new Map<number, Child>();
  const reaped: number[] = [];
  const out = { children, reaped, scans: 0, host: undefined as unknown as ReaperHost };
  out.host = {
    self: SELF,
    children: () => {
      out.scans += 1;
      return [...children.keys()];
    },
    stat: (pid) => {
      const child = children.get(pid);
      if (child === undefined) {
        return undefined;
      }
      // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice threads itrealvalue starttime
      return `${pid} (sh) ${child.state} ${child.parent ?? SELF} ${child.group ?? pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${child.start ?? 1000 + pid} 0 0`;
    },
    reap: (pid) => {
      if (children.get(pid)?.state !== "Z") {
        return false;
      }
      children.delete(pid);
      reaped.push(pid);
      return true;
    },
  };
  return out;
}

function ticks(reaper: OrphanReaper, count: number, services: number[] = []): number {
  let reaped = 0;
  for (let i = 0; i < count; i += 1) {
    reaped += reaper.tick(services);
  }
  return reaped;
}

describe("orphan reaper", () => {
  test("a dead child left by a stopped service is collected once it has stayed dead for three scans", () => {
    const procs = table();
    const reaper = new OrphanReaper(procs.host);
    // The shell is gone and the daemon has forgotten the service; its child came to us dead.
    procs.children.set(501, { state: "Z", group: 500 });
    expect(reaper.tick([])).toBe(0);
    expect(reaper.tick([])).toBe(0);
    expect(procs.reaped).toEqual([]);
    expect(reaper.tick([])).toBe(1);
    expect(procs.reaped).toEqual([501]);
  });

  test("a child Bun spawned and collects itself is never taken", () => {
    const procs = table();
    const reaper = new OrphanReaper(procs.host);
    // A hook that just exited: dead for one scan, then Bun collects it.
    procs.children.set(700, { state: "Z" });
    reaper.tick([]);
    reaper.tick([]);
    procs.children.delete(700);
    expect(ticks(reaper, 5)).toBe(0);
    expect(procs.reaped).toEqual([]);
    // Its pid comes back as another dead child: that one starts from its first sighting.
    procs.children.set(700, { state: "Z", start: 9_999 });
    expect(ticks(reaper, 2)).toBe(0);
    expect(reaper.tick([])).toBe(1);
  });

  test("a service's own process is left to Bun, also for a while after the service is gone", () => {
    const procs = table();
    const reaper = new OrphanReaper(procs.host);
    procs.children.set(300, { state: "S" });
    reaper.tick([300]);
    // It dies. Bun has not collected it yet, and the supervisor already dropped it from its list.
    procs.children.set(300, { state: "Z" });
    expect(ticks(reaper, 30, [])).toBe(0);
    expect(procs.reaped).toEqual([]);
    // Something is wrong if it is still there a minute on: then it is collected.
    expect(ticks(reaper, 40, [])).toBe(1);
    expect(procs.reaped).toEqual([300]);
  });

  test("a dead member of a running service's group is collected at once", () => {
    const procs = table();
    const reaper = new OrphanReaper(procs.host);
    procs.children.set(300, { state: "S" });
    procs.children.set(301, { state: "Z", group: 300 });
    procs.children.set(302, { state: "Z", group: 300 });
    expect(reaper.tick([300])).toBe(2);
    expect(procs.reaped.sort()).toEqual([301, 302]);
  });

  test("live children, and dead ones that are not this process's, are left alone", () => {
    const procs = table();
    const reaper = new OrphanReaper(procs.host);
    procs.children.set(400, { state: "S" });
    procs.children.set(401, { state: "R", group: 400 });
    procs.children.set(402, { state: "Z", parent: 1 });
    expect(ticks(reaper, 10, [400])).toBe(0);
    expect(procs.reaped).toEqual([]);
  });

  test("with nothing dead it looks every fifth tick, and every tick while something is", () => {
    const procs = table();
    const reaper = new OrphanReaper(procs.host);
    ticks(reaper, 20);
    expect(procs.scans).toBe(4);
    procs.children.set(501, { state: "Z" });
    procs.scans = 0;
    // The next tick is a scan, and from its first sighting the child is looked at every tick.
    expect(reaper.tick([])).toBe(0);
    expect(reaper.tick([])).toBe(0);
    expect(reaper.tick([])).toBe(1);
    expect(procs.scans).toBe(3);
    expect(procs.reaped).toEqual([501]);
    // One more look to see that nothing is left, then back to every fifth tick.
    procs.scans = 0;
    ticks(reaper, 21);
    expect(procs.scans).toBe(5);
  });
});

describe.skipIf(process.platform !== "linux")("orphan reaper on Linux", () => {
  // In a process of its own: becoming a subreaper cannot be undone, and would change who inherits the orphans of every later test.
  test("collects the orphan a shell leaves behind, and leaves Bun's own children to Bun", () => {
    const code = `
      import { startOrphanReaper } from ${JSON.stringify(MODULE)};
      const reaper = await startOrphanReaper();
      if (reaper === undefined) {
        // No glibc to call into (musl): nothing to check.
        console.log(JSON.stringify({ available: false }));
        process.exit(0);
      }
      const state = async (pid) => {
        try {
          const stat = await Bun.file("/proc/" + pid + "/stat").text();
          return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
        } catch {
          return "gone";
        }
      };
      // The shell backgrounds a sleep and exits, so the sleep is orphaned and handed to this process.
      const shell = Bun.spawn({ cmd: ["sh", "-c", "sleep 0.2 >/dev/null 2>&1 & echo $!"], stdout: "pipe" });
      const orphan = Number((await new Response(shell.stdout).text()).trim());
      await shell.exited;
      await Bun.sleep(500);
      const before = await state(orphan);
      let reaped = 0;
      const ownExits = [];
      for (let tick = 0; tick < 12 && reaped === 0; tick += 1) {
        reaped += reaper.tick([]);
        // A child of Bun's own that exits while the reaper is watching keeps its exit code.
        ownExits.push(await Bun.spawn({ cmd: ["sh", "-c", "exit 7"] }).exited);
      }
      console.log(JSON.stringify({ available: true, before, reaped, after: await state(orphan), ownExits: [...new Set(ownExits)] }));
    `;
    const result = Bun.spawnSync({ cmd: [process.execPath, "-e", code], stdout: "pipe", stderr: "pipe" });
    expect(result.stderr.toString()).toBe("");
    const got = JSON.parse(result.stdout.toString()) as Record<string, unknown>;
    if (got.available) {
      expect(got).toEqual({ available: true, before: "Z", reaped: 1, after: "gone", ownExits: [7] });
    }
  }, 30_000);
});
