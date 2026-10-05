import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { readSelfStamp, readStamp } from "./liveness.ts";

const MODULE = fileURLToPath(new URL("./liveness.ts", import.meta.url));

// Each runs in a process of its own: the stamp is remembered for the life of one.
function inFreshProcess(body: string): unknown {
  const code = `import { readSelfStamp, readStamp, rememberSelfStamp } from ${JSON.stringify(MODULE)};\n${body}`;
  const result = Bun.spawnSync({ cmd: [process.execPath, "-e", code], stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  return JSON.parse(result.stdout.toString());
}

describe("a process's own stamp", () => {
  test("is what readStamp gives for its pid, and the same every time", () => {
    const first = readSelfStamp();
    expect(first).toEqual(readStamp(process.pid));
    expect(readSelfStamp()).toEqual(first);
    // A caller that changes its copy does not change what the next one gets.
    first.lstart = "changed by a caller";
    expect(readSelfStamp().lstart).not.toBe("changed by a caller");
  });

  test("a worker that was told its process's stamp does not read it again", () => {
    const told = { bootId: "from the main thread", lstart: "from the main thread" };
    expect(inFreshProcess(`rememberSelfStamp(${JSON.stringify(told)}); console.log(JSON.stringify(readSelfStamp()));`)).toEqual(told);
  });

  test("the stamp read first stands: telling it afterwards changes nothing", () => {
    const got = inFreshProcess(`const own = readSelfStamp(); rememberSelfStamp({ lstart: "late" }); console.log(JSON.stringify([own, readSelfStamp(), readStamp(process.pid)]));`) as unknown[];
    expect(got[1]).toEqual(got[0]);
    expect(got[0]).toEqual(got[2]);
  });
});
