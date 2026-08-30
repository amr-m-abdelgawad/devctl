import { describe, expect, test } from "bun:test";
import { VERSION, versionLine } from "./version.ts";

describe("version", () => {
  test("matches package.json", async () => {
    const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(versionLine()).toBe(`devctl ${pkg.version}`);
  });
});
