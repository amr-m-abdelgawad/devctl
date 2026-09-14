import { describe, expect, test } from "bun:test";
import { emptyContainer } from "../config/types.ts";
import { DEFAULT_CONTAINER_CPUS, DEFAULT_CONTAINER_MEMORY, DEFAULT_CONTAINER_PIDS_LIMIT, isImageUserRoot, resolvedContainerLimits } from "./container-limits.ts";

describe("container limits", () => {
  test("fills memory, cpus, and pids when the service omits them", () => {
    expect(resolvedContainerLimits(emptyContainer())).toEqual({
      user: "",
      memory: DEFAULT_CONTAINER_MEMORY,
      cpus: DEFAULT_CONTAINER_CPUS,
      readOnly: false,
      capDrop: [],
      pidsLimit: DEFAULT_CONTAINER_PIDS_LIMIT,
    });
  });

  test("keeps explicit hardening fields", () => {
    expect(resolvedContainerLimits({
      ...emptyContainer(),
      user: "999:999",
      memory: "512m",
      cpus: "0.5",
      read_only: true,
      cap_drop: ["ALL", ""],
      pids_limit: 64,
    })).toEqual({
      user: "999:999",
      memory: "512m",
      cpus: "0.5",
      readOnly: true,
      capDrop: ["ALL"],
      pidsLimit: 64,
    });
  });

  test("treats an empty, numeric-zero, or root user as root", () => {
    expect(isImageUserRoot("")).toBe(true);
    expect(isImageUserRoot("0")).toBe(true);
    expect(isImageUserRoot("0:0")).toBe(true);
    expect(isImageUserRoot("root")).toBe(true);
    expect(isImageUserRoot("postgres")).toBe(false);
    expect(isImageUserRoot("999:999")).toBe(false);
  });
});
