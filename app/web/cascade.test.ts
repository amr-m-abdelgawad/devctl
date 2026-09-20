import { describe, expect, test } from "bun:test";
import { restartDependents } from "./cascade.ts";
import type { ConfigService } from "./types.ts";

function svc(name: string, dependencies: ConfigService["dependencies"] = []): ConfigService {
  return { name, description: "", dependencies };
}

describe("restartDependents", () => {
  const config = [
    svc("auth"),
    svc("api", ["auth"]),
    svc("worker", [{ service: "api", condition: "healthy" }]),
  ];

  test("returns downstream services not already named", () => {
    expect(restartDependents(config, ["auth"])).toEqual(["api", "worker"]);
    expect(restartDependents(config, ["api"])).toEqual(["worker"]);
    expect(restartDependents(config, ["worker"])).toEqual([]);
  });

  test("treats already-selected dependents as named-only", () => {
    expect(restartDependents(config, ["auth", "api", "worker"])).toEqual([]);
  });
});
