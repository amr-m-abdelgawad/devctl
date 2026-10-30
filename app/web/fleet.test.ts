import { describe, expect, test } from "bun:test";
import { fleetRows, httpPortUrl, serviceIsHealthy, toggleVisibleSelection } from "./fleet.ts";
import type { FleetState } from "./fleet.ts";
import type { ConfigService, ServiceRow } from "./types.ts";

const rows: ServiceRow[] = [
  { name: "api-10", state: "running", health: "healthy", ports: { http: 4010 }, pid: 10, last_error: "", env: "local" },
  { name: "api-2", state: "running", health: "unhealthy", ports: { http: 4002 }, pid: 2, last_error: "Health timeout", env: "staging" },
  { name: "worker", state: "stopped", health: "healthy", ports: {}, pid: 0, last_error: "" },
  { name: "db", state: "failed", health: "unknown", ports: { sql: 5432 }, pid: 0, last_error: "" },
];
const config: ConfigService[] = [{ name: "api-10", description: "Billing and invoicing", dependencies: [] }];
const profiles = [{ name: "local", services: ["api-10", "worker"] }];
const filtered = (search = "", state: FleetState = "all", profile = "", sort = "name") =>
  fleetRows(rows, config, profiles, { search, state, profile, sort }).map((row) => row.name);

describe("service fleet", () => {
  test("combines description, port and environment search with state and profile filters", () => {
    expect(filtered("billing 4010", "running", "local")).toEqual(["api-10"]);
    expect(filtered("staging", "attention")).toEqual(["api-2"]);
    expect(filtered("billing", "all", "missing-profile")).toEqual([]);
    expect(filtered("", "attention")).toEqual(["api-2", "db"]);
    expect(filtered("", "stopped")).toEqual(["worker"]);
  });

  test("sorts names naturally and puts failures before other services", () => {
    expect(filtered()).toEqual(["api-2", "api-10", "db", "worker"]);
    expect(filtered("", "all", "", "attention")).toEqual(["api-2", "db", "api-10", "worker"]);
  });

  test("does not report an unhealthy running service or stale stopped health as healthy", () => {
    expect(rows.map(serviceIsHealthy)).toEqual([true, false, false, false]);
  });

  test("http port url is the loopback address of the named http port", () => {
    expect(httpPortUrl({ http: 18003 })).toBe("http://127.0.0.1:18003/");
    expect(httpPortUrl({ HTTP: 80, db: 5432 })).toBe("http://127.0.0.1:80/");
    expect(httpPortUrl({ db: 5432 })).toBeUndefined();
    expect(httpPortUrl({ http: 0 })).toBeUndefined();
    expect(httpPortUrl({})).toBeUndefined();
  });

  test("selecting a page preserves hidden selections and unselecting removes only that page", () => {
    expect(toggleVisibleSelection(["hidden", "api-2"], ["api-2", "api-10"])).toEqual(["hidden", "api-2", "api-10"]);
    expect(toggleVisibleSelection(["hidden", "api-2", "api-10"], ["api-2", "api-10"])).toEqual(["hidden"]);
    expect(toggleVisibleSelection(["hidden"], [])).toEqual(["hidden"]);
  });
});
