import { describe, expect, test } from "bun:test";
import { serviceStamp, type StampCommand } from "./stamp.ts";

function fake(outputs: Record<string, string>): { run: StampCommand; calls: { cmd: string[]; env?: Record<string, string> }[] } {
  const calls: { cmd: string[]; env?: Record<string, string> }[] = [];
  const run: StampCommand = async (cmd, env) => {
    calls.push({ cmd, env });
    return outputs[cmd[0] ?? ""] ?? "";
  };
  return { run, calls };
}

describe("serviceStamp", () => {
  test("macOS: ps lstart and the boot time, both read in UTC with the C locale", async () => {
    const { run, calls } = fake({ ps: "Thu Oct 29 10:00:00 2026", sysctl: "{ sec = 1793000000, usec = 12 } Thu Oct 22 08:00:00 2026" });
    expect(await serviceStamp(42, "darwin", run)).toEqual({ lstart: "Thu Oct 29 10:00:00 2026", bootId: "{ sec = 1793000000, usec = 12 } Thu Oct 22 08:00:00 2026" });
    expect(calls.map((call) => call.env)).toEqual([{ TZ: "UTC", LC_ALL: "C" }, { TZ: "UTC", LC_ALL: "C" }]);
    expect(calls[0]?.cmd).toEqual(["ps", "-o", "lstart=", "-p", "42"]);
  });

  test("macOS: no start time is no stamp", async () => {
    expect(await serviceStamp(42, "darwin", fake({ sysctl: "{ sec = 1 }" }).run)).toBeUndefined();
  });

  test("Windows: the start as a UTC FILETIME", async () => {
    const { run, calls } = fake({ "powershell.exe": "134062128001234567" });
    expect(await serviceStamp(42, "win32", run)).toEqual({ lstart: "134062128001234567" });
    expect(calls[0]?.cmd.at(-1)).toContain("Get-Process -Id 42");
  });

  test("Windows: an error or a timeout is no stamp", async () => {
    expect(await serviceStamp(42, "win32", fake({ "powershell.exe": "" }).run)).toBeUndefined();
    expect(await serviceStamp(42, "win32", fake({ "powershell.exe": "Get-Process : Cannot find a process" }).run)).toBeUndefined();
  });

  test("no pid and other platforms read nothing", async () => {
    const { run, calls } = fake({});
    expect(await serviceStamp(0, "darwin", run)).toBeUndefined();
    expect(await serviceStamp(42, "freebsd", run)).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
