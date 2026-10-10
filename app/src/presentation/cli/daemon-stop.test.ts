import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import { addInstances } from "./instances.ts";
import { addDown, waitUntilStopped } from "./lifecycle.ts";

// A daemon as a command sees it once it has asked it to shut down. It is
// still there for `stopsInMs` more, stopping its services, whatever a ping to
// it would get in that time: only `daemonRunning` says when it is gone.
function stoppingDaemon(stopsInMs: number, opts: { notice?: string; checkoutExists?: boolean } = {}) {
  let askedAt: number | undefined;
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
    // With a notice, the daemon is alive and did not answer the lookup either.
    findDaemon: async () => (opts.notice === undefined ? { repoRoot: "/repo", client: there() ? client : undefined } : { repoRoot: "/repo", client: undefined, notice: opts.notice }),
    daemonRunning: async () => there(),
    listInstances: () => [{ slot: 1, repoRoot: "/repo", claimedAt: "" }],
    // Unless told otherwise, the checkout was deleted while its stack was still up.
    fileExists: () => opts.checkoutExists === true,
    readPersistedState: () => undefined,
    processAlive: () => false,
    releaseInstance: (repoRoot: string) => {
      released.push(`${repoRoot} ${there() ? "while its daemon was still there" : "once its daemon was gone"}`);
    },
  } as unknown as ClientRuntime;
  return { runtime, released, gone: () => !there(), asked: () => askedAt !== undefined };
}

// Runs one command and returns what it printed, each chunk with whether the
// daemon was gone by then.
type Printed = Array<{ text: string; daemonGone: boolean }>;

async function run(add: (root: Command, runtime: ClientRuntime) => void, daemon: ReturnType<typeof stoppingDaemon>, args: string[], chunks: Printed = []): Promise<Printed> {
  const root = new Command().option("--config <path>").exitOverride();
  add(root, daemon.runtime);
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
  test("down says it stopped the supervisor only once the daemon is gone", async () => {
    const daemon = stoppingDaemon(160);
    expect(await run(addDown, daemon, ["down"])).toEqual([{ text: "stopped services and the supervisor for /repo\n", daemonGone: true }]);
  });

  test("instances prune frees the slot once the daemon it stopped is gone", async () => {
    const daemon = stoppingDaemon(160);
    expect(await run(addInstances, daemon, ["instances", "prune"])).toEqual([{ text: "pruned slot 1 (/repo); stopped its services and supervisor\n", daemonGone: true }]);
    expect(daemon.released).toEqual(["/repo once its daemon was gone"]);
  });

  test("down fails and says the supervisor is still stopping when it outlives the deadline", async () => {
    const daemon = stoppingDaemon(60_000);
    const printed: Printed = [];
    await expect(run(addDown, daemon, ["down"], printed)).rejects.toThrow("the supervisor for /repo is still stopping after 5 s");
    expect(printed).toEqual([]);
  }, 15_000);

  test("instances prune says why it kept the slot of a daemon that is alive and does not answer", async () => {
    const paused = "devctl is paused and was not replaced. Wait for it to catch up, or stop it with `devctl down --force`.";
    const daemon = stoppingDaemon(60_000, { notice: paused });
    await expect(run(addInstances, daemon, ["instances", "prune"])).rejects.toThrow(`kept a port slot whose stack is still running:\n  slot 1 (/repo): ${paused}`);
    // It was never asked to stop, and its slot is still its own.
    expect(daemon.asked()).toBe(false);
    expect(daemon.released).toEqual([]);
  });

  test("instances lists a stack as running while its daemon is there", async () => {
    const daemon = stoppingDaemon(60_000, { checkoutExists: true });
    const printed = await run(addInstances, daemon, ["instances", "--json"]);
    expect(JSON.parse(printed.map((chunk) => chunk.text).join(""))).toEqual([{ slot: 1, repoRoot: "/repo", claimedAt: "", offset: 100, status: "running" }]);
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
