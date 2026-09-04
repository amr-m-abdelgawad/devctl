import { describe, expect, test } from "bun:test";
import { checkUpdate, compareSemver, formatUpdateStatus } from "./update.ts";
import { VERSION } from "./version.ts";

describe("update", () => {
  test("compareSemver orders dotted versions", () => {
    expect(compareSemver("0.2.0", "0.1.0")).toBe(1);
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
    expect(compareSemver("0.1.0", "1.0.0")).toBe(-1);
  });

  test("checkUpdate reports a newer GitHub release without overwriting", async () => {
    const result = await checkUpdate(async () => new Response(JSON.stringify({ tag_name: "v9.9.9" }), { status: 200 }));
    expect(result.current).toBe(VERSION);
    expect(result.latest).toBe("9.9.9");
    expect(result.newer).toBe(true);
    expect(result.hint).toStartWith("npm install --global @amr-m-abdelgawad/devctl@latest");
  });

  test("formatUpdateStatus does not overwrite the binary", () => {
    expect(formatUpdateStatus({ current: "0.2.0", latest: "0.3.0", newer: true, hint: "npm i" })).toContain("0.2.0 → 0.3.0");
    expect(formatUpdateStatus({ current: "0.2.0", latest: "0.2.0", newer: false, hint: "npm i" })).toBe("0.2.0 up to date");
    expect(formatUpdateStatus({ current: "0.2.0", latest: "", newer: false, hint: "npm i" })).toBe("0.2.0 (latest unavailable)");
  });
});
