import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import { addInstances } from "./instances.ts";
import { addDown, waitUntilStopped } from "./lifecycle.ts";

// A daemon as a command sees it once it has asked it to shut down. It is
// still there for `stopsInMs` more, stopping its services, and its socket
// misses the first ping in that time (a slow disk, a starved CPU) and answers
// the rest. Liveness is not responsiveness: only `daemonRunning` says when it
// is gone.
function stoppingDaemon(stopsInMs: number) {
  let askedAt: number | undefined;
  let pings = 0;
  const there = (): boolean => askedAt === undefined || performance.now() - askedAt < stopsInMs;
  const client = {
    call: async (method: string): Promise<unknown> => {
      if (method === "shutdown") {
        askedAt = performance.now();
      }
      return method === "config_snapshot" ? {} : null;
    },
    close: () => undefined,
  };
  const released: string[] = [];
  const runtime = {
    findDaemon: async () => ({ repoRoot: "/repo", client: there() ? client : undefined }),
    daemonRunning: async () => there(),
    tryDial: async () => {
      pings += 1;
      return there() && pings > 1 ? client : undefined;
    },
    listInstances: () => [{ slot: 1, repoRoot: "/repo", claimedAt: "" }],
    // The checkout was deleted while its stack was still up.
    fileExists: () => false,
    readPersistedState: () => undefined,
    processAlive: () => false,
    releaseInstance: (repoRoot: string) => {
      released.push(`${repoRoot} ${there() ? "while its daemon was still there" : "once its daemon was gone"}`);
    },
  } as unknown as ClientRuntime;
  return { runtime, released, gone: () => !there() };
}

// Runs one command and returns what it printed, each chunk with whether the
// daemon was gone by then.
async function run(add: (root: Command, runtime: ClientRuntime) => void, daemon: ReturnType<typeof stoppingDaemon>, args: string[]): Promise<Array<{ text: string; daemonGone: boolean }>> {
  const root = new Command().option("--config <path>").exitOverride();
  add(root, daemon.runtime);
  const chunks: Array<{ text: string; daemonGone: boolean }> = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push({ text: typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"), daemonGone: daemon.gone() });
    return true;
  }) as typeof process.stdout.write;
  try {
    await root.parseAsync(["node", "devctl", ...args], { from: "node" });
  } finally {
    process.stdout.write = original;
  }
  return chunks;
}

describe("commands that stop a daemon wait until it is gone", () => {
  test("down says it stopped the supervisor only once it has, not when a ping is first missed", async () => {
    const daemon = stoppingDaemon(160);
    expect(await run(addDown, daemon, ["down"])).toEqual([{ text: "stopped services and the supervisor for /repo\n", daemonGone: true }]);
  });

  test("instances prune frees the slot of a daemon that missed a ping while it stopped", async () => {
    const daemon = stoppingDaemon(160);
    expect(await run(addInstances, daemon, ["instances", "prune"])).toEqual([{ text: "pruned slot 1 (/repo); stopped its services and supervisor\n", daemonGone: true }]);
    expect(daemon.released).toEqual(["/repo once its daemon was gone"]);
  });

  test("the wait ends when the daemon is gone and says so", async () => {
    let looks = 0;
    const started = performance.now();
    const gone = await waitUntilStopped({ daemonRunning: async () => (looks += 1) <= 3 }, "/repo", 5_000);
    expect(gone).toBe(true);
    expect(looks).toBe(4);
    // It looks again after a pause, not in a tight loop against a daemon that is busy stopping.
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
  });

  test("the wait gives up at its deadline and says the daemon is still there", async () => {
    const started = performance.now();
    expect(await waitUntilStopped({ daemonRunning: async () => true }, "/repo", 150)).toBe(false);
    const took = performance.now() - started;
    expect(took).toBeGreaterThanOrEqual(150);
    expect(took).toBeLessThan(2_000);
  });

  test("with no time to wait it still looks once", async () => {
    expect(await waitUntilStopped({ daemonRunning: async () => false }, "/repo", 0)).toBe(true);
    expect(await waitUntilStopped({ daemonRunning: async () => true }, "/repo", 0)).toBe(false);
  });
});
