import { describe, expect, test } from "bun:test";
import {
  parseProcCmdline,
  parseProcStatComm,
  parseProcStatStarttimeTicks,
  parseProcStatmResidentKb,
  parseProcUptimeSeconds,
} from "./unix.ts";

describe("/proc parsers (ps/lsof-free process identity)", () => {
  test("joins NUL-separated cmdline and drops the trailing NUL", () => {
    expect(parseProcCmdline("uv\0run\0uvicorn\0main:app\0")).toBe("uv run uvicorn main:app");
    expect(parseProcCmdline("")).toBe("");
  });

  test("reads starttime after the final ')' so a parenthesised comm cannot shift it", () => {
    // fields: pid (comm) state ppid pgrp session tty tpgid flags min cmin maj cmaj
    //         utime stime cutime cstime prio nice threads itreal starttime(=4242)
    const stat = "100 (uv run (py)) S 50 40 40 0 -1 0 0 0 0 0 10 5 0 0 20 0 1 0 4242 12345";
    expect(parseProcStatStarttimeTicks(stat)).toBe(4242);
    expect(parseProcStatComm(stat)).toBe("uv run (py)");
    expect(parseProcStatStarttimeTicks("garbage")).toBeUndefined();
  });

  test("computes RSS in KiB from statm resident pages", () => {
    // resident = 512 pages -> 512 * 4 KiB
    expect(parseProcStatmResidentKb("2000 512 128 1 0 300 0")).toBe(2048);
    expect(parseProcStatmResidentKb("")).toBeUndefined();
  });

  test("reads the leading seconds field of /proc/uptime", () => {
    expect(parseProcUptimeSeconds("12345.67 98765.43")).toBeCloseTo(12345.67, 2);
    expect(parseProcUptimeSeconds("")).toBeUndefined();
  });
});
