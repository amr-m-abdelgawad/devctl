import { describe, expect, test } from "bun:test";
import { cgroupDirFromProc } from "./host-limits.ts";

describe("cgroup path", () => {
  test("reads the process cgroup rather than the mount root", () => {
    expect(cgroupDirFromProc("0::/devctl-memtest")).toBe("/sys/fs/cgroup/devctl-memtest");
    expect(cgroupDirFromProc("0::/\n")).toBe("/sys/fs/cgroup");
    expect(cgroupDirFromProc("1:name=systemd:/user.slice\n0::/nested/child")).toBe("/sys/fs/cgroup/nested/child");
  });
});
