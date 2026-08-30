import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "./config/types.ts";
import { completeLine, completionScript } from "./complete.ts";

describe("completions", () => {
  test("suggests commands and service names from config", () => {
    const cfg = defaultConfig();
    cfg.services.api = emptyService();
    cfg.profiles.backend = { services: ["api"], environment: {} };
    expect(completeLine("devctl ", cfg)).toContain("start");
    expect(completeLine("devctl start ", cfg)).toContain("api");
    expect(completeLine("devctl start --profile ", cfg)).toContain("backend");
    expect(completeLine("devctl completion ", cfg)).toEqual(["bash", "fish", "zsh"]);
  });

  test("prints a zsh script", () => {
    expect(completionScript("zsh")).toContain("compdef");
  });
});
