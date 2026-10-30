import { expect, test } from "bun:test";
import { logRecord } from "./record.ts";
import { matchLog } from "./filter.ts";
import { filtersDimensionsOnly } from "./facet-window.ts";

test("system noise filtering uses both service and source and bypasses dimension-only facet counts", () => {
  const rows = [
    logRecord({ service: "api", source: "stdout", level: "INFO", message: "app" }),
    logRecord({ service: "proxy", source: "stdout", level: "INFO", message: "internal" }),
    logRecord({ service: "api", source: "auth", level: "INFO", message: "internal" }),
  ];
  expect(rows.filter((row) => matchLog({ hideSystem: true }, row)).map((row) => row.service)).toEqual(["api"]);
  expect(rows.filter((row) => matchLog({}, row))).toHaveLength(3);
  expect(filtersDimensionsOnly({ hideSystem: true })).toBe(false);
});
