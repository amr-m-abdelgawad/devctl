import { describe, expect, test } from "bun:test";
import { validateConfigText } from "./load.ts";

describe("config buffer", () => {
  test("rejects invalid YAML without treating it as a mapping", () => {
    expect(validateConfigText("version: [")).toEqual([expect.stringMatching(/invalid YAML/)]);
  });

  test("rejects unknown fields", () => {
    expect(validateConfigText("version: 1\nmystery: true\n")).toEqual([expect.stringMatching(/unknown fields/)]);
  });

  test("accepts a minimal valid file", () => {
    expect(validateConfigText("version: 1\nservices:\n  api:\n    command: echo hi\n")).toEqual([]);
  });
});
