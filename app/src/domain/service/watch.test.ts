import { describe, expect, test } from "bun:test";
import { DEFAULT_WATCH_DEBOUNCE_MS, emptyWatch, watchDebounceMs } from "../config/types.ts";
import { globMatch, shouldRestartOnWatch } from "./watch.ts";

describe("shouldRestartOnWatch", () => {
  test("stays off unless enabled with a concrete path", () => {
    expect(shouldRestartOnWatch(undefined, "api/main.go")).toBe(false);
    expect(shouldRestartOnWatch(emptyWatch(), "api/main.go")).toBe(false);
    expect(shouldRestartOnWatch({ ...emptyWatch(), enabled: true }, "api/main.go")).toBe(false);
  });

  test("matches paths under an opted-in root and ignores globs", () => {
    const watch = { ...emptyWatch(), enabled: true, paths: ["invoices-api"] };
    expect(shouldRestartOnWatch(watch, "invoices-api/main.go")).toBe(true);
    expect(shouldRestartOnWatch(watch, "invoices-api")).toBe(true);
    expect(shouldRestartOnWatch(watch, "other/main.go")).toBe(false);
    expect(shouldRestartOnWatch(watch, "invoices-api/node_modules/pkg/index.js")).toBe(false);
    expect(shouldRestartOnWatch(watch, "../secret")).toBe(false);
  });

  test("watchDebounceMs rejects zero and negative values", () => {
    expect(watchDebounceMs(800)).toBe(800);
    expect(watchDebounceMs(0)).toBe(DEFAULT_WATCH_DEBOUNCE_MS);
    expect(watchDebounceMs(-15)).toBe(DEFAULT_WATCH_DEBOUNCE_MS);
  });

  test("globMatch understands ** and *", () => {
    expect(globMatch("**/node_modules/**", "invoices-api/node_modules/pkg/index.js")).toBe(true);
    expect(globMatch("**/.git/**", "invoices-api/.git/HEAD")).toBe(true);
    expect(globMatch("*.go", "main.go")).toBe(true);
    expect(globMatch("*.go", "cmd/main.go")).toBe(false);
  });
});
