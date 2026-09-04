import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyEnv, emptyService } from "../config/types.ts";
import {
  configExitText,
  configExtraFacts,
  configGoogleFacts,
  configHeaderChips,
  configLogFacts,
  configProfileRows,
  configProjectFacts,
  configProxyFacts,
  configRouteRows,
  configRuntimeFacts,
  configServiceNameWidth,
  configServiceRows,
  configTaskRows,
  configTemplateRows,
  formatConfigDiffText,
} from "./config-view.ts";

function sampleConfig() {
  const cfg = defaultConfig();
  cfg.project.name = "demo-platform";
  cfg.configPath = "/repo/.devctl/config.yaml";
  cfg.repoRoot = "/repo";
  cfg.google.project_id = "company-dev";
  cfg.google.region = "europe-west1";
  cfg.shutdown.stop_services_on_exit = true;
  cfg.shutdown.grace_seconds = 5;
  cfg.environment.sources = [".env"];
  cfg.proxy.enabled = true;
  cfg.proxy.listen = { host: "127.0.0.1", port: 18080 };
  cfg.proxy.token_endpoint = { enabled: true, host: "127.0.0.1", port: 18090 };
  cfg.proxy.routes = [
    {
      name: "invoices-api",
      match: { host: "invoices-api.local", path: "" },
      upstream: { url: "http://127.0.0.1:18000" },
      auth: { type: "none", identity: { type: "user", service_account: "" }, audience: "", service_account: "" },
    },
  ];
  cfg.services["invoices-api"] = {
    ...emptyService(),
    extends: "python-http",
    command: { args: ["python3", "main.py"], shell: false },
    dependencies: ["identity"],
    ports: [{ name: "http", value: 18000, auto: false }],
    health: { ...emptyService().health, type: "http", url: "http://127.0.0.1:18000/health" },
    identity: { type: "user", mode: "", service_account: "" },
    restart: { policy: "on_failure", max_retries: 2, backoff_seconds: 1 },
  };
  cfg.profiles.backend = { services: ["identity", "invoices-api"], environment: { LOG_LEVEL: "INFO" } };
  cfg.templates["python-http"] = {
    ...emptyService(),
    health: { ...emptyService().health, type: "http" },
    restart: { policy: "on_failure", max_retries: 2, backoff_seconds: 1 },
    logs: { stdout: true, stderr: true },
  };
  cfg.doctor.tools = [{ name: "python3", command: "python3" }];
  return cfg;
}

describe("config view", () => {
  test("header chips summarize the merged file", () => {
    const chips = configHeaderChips(sampleConfig());
    expect(chips.map((chip) => chip.text)).toEqual(["demo-platform", "schema 1", "1 service", "1 profile", "proxy on", "1 route"]);
  });

  test("project google runtime and logs expose more than the old path list", () => {
    const cfg = sampleConfig();
    expect(configProjectFacts(cfg, "0.1.0").map((fact) => fact.label)).toEqual(["path", "repo", "devctl", "schema"]);
    expect(configGoogleFacts(cfg).map((fact) => fact.value)).toEqual(["company-dev", "europe-west1"]);
    expect(configRuntimeFacts(cfg).find((fact) => fact.label === "exit")?.value).toBe("stop services");
    expect(configRuntimeFacts(cfg).find((fact) => fact.label === "env")?.value).toBe(".env");
    expect(configLogFacts(cfg).find((fact) => fact.label === "persist")?.value).toBe("~/.devctl/logs");
    expect(configProxyFacts(cfg).map((fact) => fact.value)).toEqual(["127.0.0.1:18080", "127.0.0.1:18090"]);
  });

  test("service profile route and template rows keep the useful columns", () => {
    const cfg = sampleConfig();
    const service = configServiceRows(cfg)[0];
    expect(service?.name).toBe("invoices-api");
    expect(service?.ports).toContain("18000");
    expect(service?.depends).toBe("identity");
    expect(service?.extends).toBe("python-http");
    expect(configRouteRows(cfg)[0]?.match).toBe("invoices-api.local");
    expect(configProfileRows(cfg)[0]?.env).toBe("LOG_LEVEL");
    expect(configTemplateRows(cfg)[0]?.summary).toContain("health http");
    expect(configExtraFacts(cfg).find((fact) => fact.label === "doctor")?.value).toBe("python3");
    expect(configServiceNameWidth(configServiceRows(cfg))).toBeGreaterThanOrEqual(8);
  });

  test("task rows and provenance overlay include winning sources", () => {
    const cfg = sampleConfig();
    cfg.tasks.seed = { command: { args: ["bun", "run", "seed"], shell: false }, shell: false, working_dir: ".", dependencies: ["identity"], environment: emptyEnv() };
    expect(configHeaderChips(cfg).map((chip) => chip.text)).toContain("1 task");
    expect(configTaskRows(cfg)[0]).toEqual({ name: "seed", summary: "bun run seed  depends identity" });
    cfg.provenance["google.project_id"] = [
      { source: "/home/.devctl/config.yaml", layer: "home" },
      { source: "/repo/.devctl/config.yaml", layer: "main" },
    ];
    const text = formatConfigDiffText(cfg, false);
    expect(text).toContain("google.project_id");
    expect(text).toContain("main");
    expect(text).toContain("shadowed");
  });

  test("exit text covers ask stop and detach", () => {
    const cfg = defaultConfig();
    expect(configExitText(cfg)).toBe("ask on quit");
    cfg.shutdown.stop_services_on_exit = false;
    expect(configExitText(cfg)).toBe("detach");
    cfg.shutdown.stop_services_on_exit = true;
    expect(configExitText(cfg)).toBe("stop services");
  });
});
