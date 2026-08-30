import { describe, expect, test } from "bun:test";
import { checkUpdate, compareSemver } from "./update.ts";
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
    expect(result.hint).toContain("brew install");
  });

  test("checkUpdate stays quiet when the API is unavailable", async () => {
    const result = await checkUpdate(async () => new Response("no", { status: 503 }));
    expect(result.latest).toBe("");
    expect(result.newer).toBe(false);
  });
});
