import { describe, expect, test } from "bun:test";
import { instanceStatusLine } from "./status.ts";

describe("instanceStatusLine", () => {
  test("a checkout's own stack in slot 0 has no line", () => {
    expect(instanceStatusLine(undefined)).toBeUndefined();
    expect(instanceStatusLine({ name: "", slot: 0, port_offset: 0 })).toBeUndefined();
  });

  test("names the slot, and the instance when it has one", () => {
    expect(instanceStatusLine({ slot: 1, port_offset: 100 })).toBe("INSTANCE: slot 1 (ports +100)");
    expect(instanceStatusLine({ name: "ci-7", slot: 2, port_offset: 200 })).toBe("INSTANCE: ci-7, slot 2 (ports +200)");
  });
});
