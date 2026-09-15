import { describe, expect, test } from "bun:test";
import { mergeVars } from "./vars.ts";

describe("mergeVars", () => {
  test("applies highest-to-lowest precedence", () => {
    const merged = mergeVars({
      runtime: { k: "runtime" },
      request: [{ name: "k", value: "request", enabled: true }, { name: "req", value: "1", enabled: true }],
      folders: [
        [{ name: "k", value: "parent", enabled: true }, { name: "parent", value: "p", enabled: true }],
        [{ name: "k", value: "child", enabled: true }, { name: "child", value: "c", enabled: true }],
      ],
      selected: { k: "env", env: "e" },
      collection: [{ name: "k", value: "collection", enabled: true }, { name: "col", value: "x", enabled: true }],
      processEnv: { k: "proc", PATH: "/bin" },
    });
    expect(merged.k).toBe("runtime");
    expect(merged.req).toBe("1");
    expect(merged.child).toBe("c");
    expect(merged.parent).toBe("p");
    expect(merged.env).toBe("e");
    expect(merged.col).toBe("x");
    expect(merged.PATH).toBe("/bin");
  });

  test("skips disabled vars and empty names", () => {
    const merged = mergeVars({
      request: [
        { name: "off", value: "no", enabled: false },
        { name: "", value: "x", enabled: true },
        { name: "on", value: "yes", enabled: true },
      ],
    });
    expect(merged.off).toBeUndefined();
    expect(merged.on).toBe("yes");
    expect(merged[""]).toBeUndefined();
  });

  test("leaf folder vars override parent folder vars", () => {
    const merged = mergeVars({
      folders: [
        [{ name: "shared", value: "parent", enabled: true }],
        [{ name: "shared", value: "child", enabled: true }],
      ],
    });
    expect(merged.shared).toBe("child");
  });
});
