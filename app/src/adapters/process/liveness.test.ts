import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { readSelfStamp, readStamp, sameStamp } from "./liveness.ts";

const MODULE = fileURLToPath(new URL("./liveness.ts", import.meta.url));

// Each runs in a process of its own: the stamp is kept for the life of one.
// The readers are stand-ins, so nothing here waits on `ps` or PowerShell.
function inFreshProcess(body: string): unknown {
  const code = `import { readSelfStamp, rememberSelfStamp } from ${JSON.stringify(MODULE)};\n${body}`;
  const result = Bun.spawnSync({ cmd: [process.execPath, "-e", code], stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  return JSON.parse(result.stdout.toString());
}

describe("a process's own stamp", () => {
  test("agrees with what readStamp gives for its pid, and a caller's copy is its own", () => {
    const own = readSelfStamp();
    // Either read can time out where it spawns, so they are compared as two stamps of one process are.
    expect(sameStamp(own, readStamp(process.pid))).toBe(true);
    own.lstart = "changed by a caller";
    expect(readSelfStamp().lstart).not.toBe("changed by a caller");
    // Up to three reads, each of which may wait a second for PowerShell on Windows.
  }, 15_000);

  test.skipIf(process.platform === "win32")("is the same on every read where reading it is reliable", () => {
    expect(readSelfStamp()).toEqual(readStamp(process.pid));
    expect(readSelfStamp()).toEqual(readSelfStamp());
  });

  test("is read once: later reads get the first one that had a start time", () => {
    expect(inFreshProcess(`
      const reads = [];
      const reader = (stamp) => () => { reads.push(stamp); return stamp; };
      const got = [readSelfStamp(reader({ lstart: "first" })), readSelfStamp(reader({ lstart: "second" })), readSelfStamp(reader({ lstart: "third" }))];
      console.log(JSON.stringify({ got, reads: reads.length }));
    `)).toEqual({ got: [{ lstart: "first" }, { lstart: "first" }, { lstart: "first" }], reads: 1 });
  });

  test("a read that timed out is not kept: the next call reads again", () => {
    expect(inFreshProcess(`
      const timedOut = () => ({});
      const got = [readSelfStamp(timedOut), readSelfStamp(() => ({ lstart: "answered" })), readSelfStamp(() => ({ lstart: "never asked" }))];
      console.log(JSON.stringify(got));
    `)).toEqual([{}, { lstart: "answered" }, { lstart: "answered" }]);
  });

  test("after three reads that timed out it stops asking", () => {
    expect(inFreshProcess(`
      let reads = 0;
      const timedOut = () => { reads += 1; return { bootId: "boot" }; };
      for (let i = 0; i < 6; i += 1) readSelfStamp(timedOut);
      console.log(JSON.stringify({ reads, last: readSelfStamp(() => ({ lstart: "too late" })) }));
    `)).toEqual({ reads: 3, last: { bootId: "boot" } });
  });

  test("a worker that was told its process's stamp does not read it", () => {
    const told = { bootId: "from the main thread", lstart: "from the main thread" };
    expect(inFreshProcess(`
      rememberSelfStamp(${JSON.stringify(told)});
      rememberSelfStamp({ lstart: "told again" });
      let reads = 0;
      console.log(JSON.stringify({ stamp: readSelfStamp(() => { reads += 1; return {}; }), reads }));
    `)).toEqual({ stamp: told, reads: 0 });
  });

  test("a worker told a stamp with no start time reads its own", () => {
    expect(inFreshProcess(`
      rememberSelfStamp({ bootId: "the main thread's read timed out" });
      console.log(JSON.stringify(readSelfStamp(() => ({ lstart: "read by the worker" }))));
    `)).toEqual({ lstart: "read by the worker" });
  });
});
