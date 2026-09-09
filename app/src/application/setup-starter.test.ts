import { describe, expect, test } from "bun:test";
import { defaultStarterAnswers, parseProxyPort, SETUP_FIELDS, starterConfigYaml } from "./setup-starter.ts";

describe("setup starter", () => {
  test("exposes the nine wizard fields", () => {
    expect(SETUP_FIELDS.map((field) => field.id)).toEqual(["repo", "name", "project", "auth", "sa", "audience", "port", "profile", "write"]);
  });

  test("starter YAML includes mapped answers only", () => {
    const yaml = starterConfigYaml({
      ...defaultStarterAnswers("/repo/demo", "my-proj"),
      name: "demo",
      sa: "sa@x",
      audience: "aud",
      proxyPort: parseProxyPort("9090"),
    });
    expect(yaml).toContain("name: demo");
    expect(yaml).toContain("project_id: my-proj");
    expect(yaml).toContain("port: 9090");
    expect(yaml).toContain("audience: aud");
    expect(yaml).toContain("service_account: sa@x");
  });
});
