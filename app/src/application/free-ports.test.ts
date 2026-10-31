import { describe, expect, test } from "bun:test";
import { hintError, KindProcessStart } from "../shared/errors.ts";
import { describePortFrees, freePortHolders, MAX_PORTS_FREED_AT_ONCE } from "./free-ports.ts";

describe("freePortHolders", () => {
  test("frees every holder and keeps going when one refuses", async () => {
    const seen: number[] = [];
    const results = await freePortHolders(
      [
        { port: 18003, pid: 1, command: "bun" },
        { port: 18004, pid: 2, command: "node" },
        { port: 18005, pid: 3, command: "python" },
      ],
      async (holder) => {
        seen.push(holder.port);
        if (holder.port === 18004) {
          throw hintError(KindProcessStart, `port ${holder.port} is now held by other (pid 99), not pid ${holder.pid}`, "refresh Doctor");
        }
        return holder.port === 18005 ? "already-free" : "stopped";
      },
    );
    expect(seen).toEqual([18003, 18004, 18005]);
    expect(results).toEqual([
      { port: 18003, pid: 1, command: "bun", result: "stopped" },
      {
        port: 18004,
        pid: 2,
        command: "node",
        error: "port 18004 is now held by other (pid 99), not pid 2 — refresh Doctor",
      },
      { port: 18005, pid: 3, command: "python", result: "already-free" },
    ]);
    expect(describePortFrees(results)).toBe("Stopped 18003. Already free: 18005. 18004 was not freed: port 18004 is now held by other (pid 99), not pid 2 — refresh Doctor");
  });

  test("refuses a batch larger than the cap before stopping anything", async () => {
    let calls = 0;
    const holders = Array.from({ length: MAX_PORTS_FREED_AT_ONCE + 1 }, (_, index) => ({
      port: index + 1,
      pid: index + 1,
      command: "proc",
    }));
    await expect(
      freePortHolders(holders, async () => {
        calls += 1;
        return "stopped";
      }),
    ).rejects.toThrow(`Free up to ${MAX_PORTS_FREED_AT_ONCE} ports at once`);
    expect(calls).toBe(0);
    expect(describePortFrees([])).toBe("No ports freed");
  });
});
