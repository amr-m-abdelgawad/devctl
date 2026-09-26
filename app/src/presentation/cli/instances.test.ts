import { describe, expect, test } from "bun:test";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import type { PersistedProcess } from "../../domain/session/session.ts";
import { formatInstances, stillRunning } from "./instances.ts";

function runtime(opts: { daemon?: boolean; processes?: Pick<PersistedProcess, "name" | "pid">[]; alive?: number[] }) {
  return {
    tryDial: () => Promise.resolve(opts.daemon ? ({ close: () => undefined } as unknown as Awaited<ReturnType<ClientRuntime["tryDial"]>>) : undefined),
    readPersistedState: () =>
      opts.processes === undefined ? undefined : ({ session_id: "", repo_root: "/gone", profile: "", processes: opts.processes as PersistedProcess[] }),
    processAlive: (pid: number) => (opts.alive ?? []).includes(pid),
  };
}

describe("devctl instances", () => {
  test("lists slots with their offset, checkout, listener ports and status", () => {
    const out = formatInstances([
      { slot: 0, offset: 0, repoRoot: "/src/app", claimedAt: "", status: "running", ports: { proxy: 18080, web: 18900, otlp: 18418 } },
      { slot: 1, offset: 100, repoRoot: "/src/app-review-42", claimedAt: "", status: "missing" },
      { slot: 2, offset: 200, repoRoot: "/src/app", instance: "ci-7", claimedAt: "", status: "stopped" },
    ]);
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^SLOT\s+OFFSET\s+CHECKOUT\s+INSTANCE\s+PROXY\s+WEB\s+OTLP\s+STATUS$/);
    expect(lines[1]).toMatch(/^0\s+\+0\s+\/src\/app\s+-\s+18080\s+18900\s+18418\s+running$/);
    expect(lines[2]).toMatch(/^1\s+\+100\s+\/src\/app-review-42\s+-\s+-\s+-\s+-\s+missing \(run `devctl instances prune`\)$/);
    expect(lines[3]).toMatch(/^2\s+\+200\s+\/src\/app\s+ci-7\s+-\s+-\s+-\s+stopped$/);
  });

  test("says so when no stack holds a slot", () => {
    expect(formatInstances([])).toBe("no stacks hold a port slot\n");
  });

  test("prune frees a slot only once the supervisor and its services are gone", async () => {
    expect(await stillRunning(runtime({}), "/gone")).toBeUndefined();
    expect(await stillRunning(runtime({ processes: [{ name: "api", pid: 41 }], alive: [] }), "/gone")).toBeUndefined();
    expect(await stillRunning(runtime({ daemon: true }), "/gone")).toContain("its supervisor did not stop in time");
    // `down --keep-services` then the checkout was deleted: no supervisor, services still up.
    expect(await stillRunning(runtime({ processes: [{ name: "api", pid: 41 }, { name: "web", pid: 42 }], alive: [42] }), "/gone")).toBe(
      "services still running (web pid 42); stop them, then prune again",
    );
  });
});
