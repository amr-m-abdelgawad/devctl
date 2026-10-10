import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { cgroupDirFromProc, cgroupMemory, workingSetBytes } from "./host-limits.ts";

describe("cgroup path", () => {
  test("reads the process cgroup rather than the mount root", () => {
    expect(cgroupDirFromProc("0::/devctl-memtest")).toBe("/sys/fs/cgroup/devctl-memtest");
    expect(cgroupDirFromProc("0::/\n")).toBe("/sys/fs/cgroup");
    expect(cgroupDirFromProc("1:name=systemd:/user.slice\n0::/nested/child")).toBe("/sys/fs/cgroup/nested/child");
  });
});

// A cgroup mount on disk: one directory per level, with the files the kernel exposes.
function cgroupTree(files: Record<string, string>): { mount: string; close: () => void } {
  const mount = mkdtempSync(join(tmpdir(), "devctl-cgroup-"));
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split("/");
    mkdirSync(join(mount, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(mount, ...parts), text);
  }
  return { mount, close: () => rmSync(mount, { recursive: true, force: true }) };
}

describe("container working set", () => {
  test("cgroup v2: usage less inactive file cache, as docker stats shows", () => {
    const tree = cgroupTree({
      "memory.max": "1000\n",
      "memory.current": "900\n",
      "memory.stat": "anon 500\nfile 400\nactive_file 100\ninactive_file 300\n",
    });
    try {
      expect(cgroupMemory(tree.mount, "0::/\n")).toEqual({ limit: 1000, used: 600 });
    } finally {
      tree.close();
    }
  });

  test("a parent's limit binds a nested cgroup that has none of its own", () => {
    const tree = cgroupTree({
      "a/memory.max": "2000\n",
      "a/memory.current": "1900\n",
      "a/memory.stat": "inactive_file 100\n",
      "a/b/memory.max": "max\n",
      "a/b/memory.current": "700\n",
      "a/b/memory.stat": "inactive_file 0\n",
    });
    try {
      expect(cgroupMemory(tree.mount, "0::/a/b\n")).toEqual({ limit: 2000, used: 1800 });
    } finally {
      tree.close();
    }
  });

  test("the level closest to its limit wins when several have one", () => {
    const tree = cgroupTree({
      "memory.max": "10000\n",
      "memory.current": "2000\n",
      "a/memory.max": "1000\n",
      "a/memory.current": "950\n",
    });
    try {
      expect(cgroupMemory(tree.mount, "0::/a\n")).toEqual({ limit: 1000, used: 950 });
    } finally {
      tree.close();
    }
  });

  test("cgroup v1: usage less total_inactive_file from the memory hierarchy", () => {
    const tree = cgroupTree({
      "memory/memory.limit_in_bytes": "1000\n",
      "memory/memory.usage_in_bytes": "800\n",
      "memory/memory.stat": "inactive_file 10\ntotal_inactive_file 300\n",
    });
    try {
      expect(cgroupMemory(tree.mount, "4:memory:/docker/abc\n")).toEqual({ limit: 1000, used: 500 });
    } finally {
      tree.close();
    }
  });

  test("no limit anywhere leaves the guard on RSS against host memory", () => {
    const tree = cgroupTree({
      "memory.max": "max\n",
      "memory.current": "900\n",
      "memory/memory.limit_in_bytes": "9223372036854771712\n",
    });
    try {
      expect(cgroupMemory(tree.mount, "0::/\n")).toBeUndefined();
    } finally {
      tree.close();
    }
  });

  test("a stat read that does not fit under usage leaves usage", () => {
    expect(workingSetBytes(500, "inactive_file 800\n", "inactive_file")).toBe(500);
    expect(workingSetBytes(500, undefined, "inactive_file")).toBe(500);
    expect(workingSetBytes(500, "inactive_file 200\n", "inactive_file")).toBe(300);
  });
});
