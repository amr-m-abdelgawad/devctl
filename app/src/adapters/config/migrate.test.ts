import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../domain/config/types.ts";
import { migrate } from "./migrate.ts";

describe("config migrate", () => {
  test("current version is a no-op", () => {
    const cfg = defaultConfig();
    expect(migrate(cfg)).toBe(cfg);
  });

  test("version 0 is rejected", () => {
    const cfg = defaultConfig();
    cfg.version = 0;
    expect(() => migrate(cfg)).toThrow("version is required");
  });

  test("unknown versions have no migration", () => {
    const cfg = defaultConfig();
    cfg.version = 99;
    expect(() => migrate(cfg)).toThrow(/unsupported config version 99/);
  });
});
