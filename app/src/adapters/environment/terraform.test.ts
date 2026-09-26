import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "../../domain/config/types.ts";
import { KindConfiguration } from "../../shared/errors.ts";
import { extractTerraformEnv, loadTerraformEnvironment, terraformConfigIssues } from "./terraform.ts";

const CLOUD_RUN = `
# deployed api
resource "google_cloud_run_v2_service" "api" {
  name     = "api"
  location = var.region

  template {
    containers {
      image = "example"

      env {
        name  = "LOG_LEVEL"
        value = "info"
      }
      env { name = "PUBLIC_URL" value = "https://api.example.com" }
      env {
        name = "DB_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = "projects/example/secrets/db-password"
            version = "latest"
          }
        }
      }
      env {
        name  = "PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "REGION"
        value = "\${var.region}"
      }
      env {
        name  = "LITERAL_DOLLAR"
        value = "$\${not_interp}"
      }
    }
  }
}

resource "google_cloud_run_v2_service" "worker" {
  template {
    containers {
      env {
        name  = "ROLE"
        value = "worker"
      }
    }
  }
}
`;

describe("terraform env extraction", () => {
  test("reads literal env blocks and skips secrets, references, and other resources", () => {
    const filtered = extractTerraformEnv([{ name: "main.tf", text: CLOUD_RUN }], "google_cloud_run_v2_service.api", "");
    expect(filtered.foundResource).toBe(true);
    expect(filtered.values).toEqual({
      LOG_LEVEL: "info",
      PUBLIC_URL: "https://api.example.com",
      LITERAL_DOLLAR: "${not_interp}",
    });

    const all = extractTerraformEnv([{ name: "main.tf", text: CLOUD_RUN }], "", "");
    expect(all.values.ROLE).toBe("worker");
    expect(all.values.LOG_LEVEL).toBe("info");
  });

  test("reads maps, lists, numbers, bools, heredocs, and a custom attribute", () => {
    const text = `
      locals {
        service_env = {
          FROM_LOCAL = "yes"
        }
      }
      resource "google_cloud_run_v2_service" "api" {
        template {
          containers {
            env = [
              { name = "FROM_LIST", value = "list" },
              { name = "SECRET", value_source = { secret = "x" } },
            ]
            environment_variables = {
              PORT = 8080
              DEBUG = true
              SKIPPED = var.region
              NULLISH = null
              NOTE = "line\\nbreak"
            }
            env {
              name = "CONFIG"
              value = <<-EOT
              {"ok":true}
              EOT
            }
          }
        }
      }
      variable "env_vars" {
        default = { FROM_VARIABLE = "var" }
      }
    `;
    const selected = extractTerraformEnv([{ name: "main.tf", text }], "google_cloud_run_v2_service.api", "service_env");
    expect(selected.values).toEqual({
      FROM_LIST: "list",
      PORT: "8080",
      DEBUG: "true",
      NOTE: "line\nbreak",
      CONFIG: "{\"ok\":true}\n",
    });
    expect(selected.values.FROM_LOCAL).toBeUndefined();
    expect(selected.values.FROM_VARIABLE).toBeUndefined();
    expect(selected.values.SECRET).toBeUndefined();

    const wholeFile = extractTerraformEnv([{ name: "main.tf", text }], "", "service_env");
    expect(wholeFile.values.FROM_LOCAL).toBe("yes");
    expect(wholeFile.values.FROM_VARIABLE).toBe("var");
    expect(wholeFile.values.PORT).toBe("8080");
  });

  test("keeps a module address and lets a later file win", () => {
    const first = extractTerraformEnv([
      { name: "a.tf", text: `module "api" { env_vars = { SHARED = "first" ONLY = "a" } }` },
      { name: "b.tf", text: `module "api" { env_vars = { SHARED = "second" } }` },
    ], "module.api", "");
    expect(first.values).toEqual({ SHARED: "second", ONLY: "a" });
  });

  test("reports a missing resource and an unterminated string", () => {
    const missing = extractTerraformEnv([{ name: "main.tf", text: CLOUD_RUN }], "google_cloud_run_v2_service.missing", "");
    expect(missing.foundResource).toBe(false);
    expect(() => extractTerraformEnv([{ name: "main.tf", text: `env { name = "FOO }` }], "", "")).toThrow(/main\.tf:\d+: unterminated string/);
  });
});

describe("terraform env config", () => {
  test("rejects a path outside the repo, a missing resource, and an empty file", () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-tf-"));
    writeFileSync(join(dir, "empty.tf"), `resource "google_cloud_run_v2_service" "api" {\n  name = var.name\n}\n`);
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.services.api = emptyService();
    cfg.services.api.environment.terraform = { path: "../secret.tf", resource: "", attribute: "" };
    expect(terraformConfigIssues(cfg).join("\n")).toContain("must stay inside the repository");

    cfg.services.api.environment.terraform = { path: "empty.tf", resource: "google_cloud_run_v2_service.api", attribute: "" };
    expect(terraformConfigIssues(cfg).join("\n")).toContain("no literal env values");

    cfg.services.api.environment.terraform = { path: "empty.tf", resource: "google_cloud_run_v2_service.other", attribute: "" };
    expect(terraformConfigIssues(cfg).join("\n")).toContain('resource "google_cloud_run_v2_service.other" was not found');

    cfg.services.api.environment.terraform = { path: "missing.tf", resource: "", attribute: "" };
    expect(terraformConfigIssues(cfg).join("\n")).toContain("not found: missing.tf");

    cfg.services.api.environment.terraform = { path: "empty.tf", resource: "not an address", attribute: "" };
    expect(terraformConfigIssues(cfg).join("\n")).toContain("must look like type.name");

    cfg.services.api.environment.terraform = { path: "", resource: "", attribute: "", invalid: true };
    expect(terraformConfigIssues(cfg).join("\n")).toContain("must be a path or an object with path");

    cfg.services.api.environment.terraform = undefined;
    cfg.profiles.local = {
      services: [],
      environment: {},
      environments: {},
      service_environment: {
        api: { vars: {}, required: [], defaults: {}, terraform: { path: "../nope.tf", resource: "", attribute: "" } },
      },
    };
    expect(terraformConfigIssues(cfg).join("\n")).toContain("profiles.local.service_environment.api.terraform.path must stay inside the repository");
  });

  test("reads a directory of .tf files and ignores .tfvars", () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-tf-dir-"));
    const deploy = join(dir, "deploy");
    mkdirSync(deploy);
    writeFileSync(join(deploy, "a.tf"), `env { name = "FROM_A" value = "a" }\n`);
    writeFileSync(join(deploy, "b.tf"), `env { name = "FROM_A" value = "b" }\n`);
    writeFileSync(join(deploy, "secrets.tfvars"), `env { name = "SECRET" value = "nope" }\n`);
    mkdirSync(join(deploy, "nested"));
    writeFileSync(join(deploy, "nested", "c.tf"), `env { name = "NESTED" value = "c" }\n`);
    const values = loadTerraformEnvironment(dir, "services.api.environment.terraform", {
      path: "deploy",
      resource: "",
      attribute: "",
    });
    expect(values).toEqual({ FROM_A: "b" });
  });

  test("reads terraform.tfvars and auto.tfvars, and an explicit .tfvars path", () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-tfvars-"));
    const deploy = join(dir, "deploy");
    mkdirSync(deploy);
    writeFileSync(join(deploy, "main.tf"), `
      variable "project_id" { default = "from-default" }
      variable "environment_variables" { default = { FROM_DEFAULT = "default" DROPPED = "no" } }
      resource "google_cloud_run_v2_service" "api" {
        template {
          containers {
            env { name = "PROJECT_ID" value = var.project_id }
            env { name = "FROM_BLOCK" value = "block" }
          }
        }
      }
    `);
    writeFileSync(join(deploy, "other.tf"), `
      resource "google_cloud_run_v2_service" "other" {
        template { containers { env { name = "OTHER" value = "no" } } }
      }
    `);
    writeFileSync(join(deploy, "terraform.tfvars"), `
      project_id = "from-tfvars"
      environment_variables = { FROM_TFVARS = "tfvars" }
    `);
    writeFileSync(join(deploy, "local.auto.tfvars"), `project_id = "from-auto"\n`);
    writeFileSync(join(deploy, "secrets.tfvars"), `project_id = "secret"\n`);
    const selected = loadTerraformEnvironment(dir, "services.api.environment.terraform", {
      path: "deploy",
      resource: "google_cloud_run_v2_service.api",
      attribute: "",
    });
    expect(selected).toEqual({ PROJECT_ID: "from-auto", FROM_BLOCK: "block" });

    const whole = loadTerraformEnvironment(dir, "services.api.environment.terraform", {
      path: "deploy/main.tf",
      resource: "",
      attribute: "",
    });
    expect(whole.PROJECT_ID).toBe("from-auto");
    expect(whole.FROM_BLOCK).toBe("block");
    expect(whole.FROM_TFVARS).toBe("tfvars");
    expect(whole.DROPPED).toBeUndefined();
    expect(whole.OTHER).toBeUndefined();

    writeFileSync(join(deploy, "dev.tfvars"), `project_id = "from-dev"\n`);
    const explicit = loadTerraformEnvironment(dir, "services.api.environment.terraform", {
      path: "deploy/dev.tfvars",
      resource: "google_cloud_run_v2_service.api",
      attribute: "",
    });
    expect(explicit.PROJECT_ID).toBe("from-dev");
    expect(explicit.FROM_BLOCK).toBe("block");
  });

  test("rejects a directory symlink that leaves the repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-tf-link-"));
    const outside = mkdtempSync(join(tmpdir(), "devctl-tf-outside-"));
    writeFileSync(join(outside, "main.tf"), `env { name = "LEAK" value = "no" }\n`);
    symlinkSync(outside, join(dir, "escape"));
    expect(() => loadTerraformEnvironment(dir, "services.api.environment.terraform", {
      path: "escape",
      resource: "",
      attribute: "",
    })).toThrow(KindConfiguration);
  });
});
