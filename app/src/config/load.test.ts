import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { load } from "./load.ts";
import { configDiff } from "./provenance.ts";

function writeFile(dir: string, rel: string, contents: string): void {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

describe("config load", () => {
  test("decodes and validates a container service", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-ts-container-${Date.now()}`;
    writeFile(dir, ".devctl/config.yaml", `
version: 1
services:
  postgres:
    ports: { db: 5432 }
    container:
      image: postgres:16
      runtime: docker
      ports: { db: 5432 }
      env: { POSTGRES_PASSWORD: local }
      volumes: [pgdata:/var/lib/postgresql/data]
`);
    const cfg = load(dir, "");
    expect(cfg.services.postgres?.container).toEqual({
      image: "postgres:16", runtime: "docker", ports: { db: 5432 },
      env: { POSTGRES_PASSWORD: "local" }, volumes: ["pgdata:/var/lib/postgresql/data"],
    });
  });

  test("loads modular example with templates and env refs", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-ts-cfg-${Date.now()}`;
    writeFile(
      dir,
      ".devctl/config.yaml",
      `
version: 1
project:
  name: demo
profiles:
  backend:
    services: [auth, api]
templates:
  python-service:
    health:
      type: process
    logs:
      stdout: true
      stderr: true
services:
  auth:
    command: [python, -m, http.server, "8001"]
    working_dir: services/auth
    ports:
      http: 8001
    health:
      type: http
      url: http://127.0.0.1:8001/health
    identity:
      type: user
  api:
    extends: python-service
    command: python main.py
    working_dir: services/api
    dependencies: [auth]
    ports:
      http: 8000
    environment:
      AUTH_URL: http://127.0.0.1:\${services.auth.ports.http}
      required:
        - AUTH_URL
      defaults:
        LOG_LEVEL: INFO
    identity:
      type: user
proxy:
  enabled: true
  listen:
    host: 127.0.0.1
    port: 8080
  routes:
    - name: billing
      match:
        host: billing.local
      upstream:
        url: https://billing.example.com
      auth:
        type: iap
        audience: "/projects/1/iap"
        identity: user
`,
    );
    const cfg = load(dir, "");
    expect(cfg.project.name).toBe("demo");
    expect(cfg.services.api?.dependencies).toEqual(["auth"]);
    expect(cfg.services.api?.health.type).toBe("process");
    expect(cfg.services.api?.environment.vars.AUTH_URL).toBe("http://127.0.0.1:${services.auth.ports.http}");
    expect(cfg.proxy.routes[0]?.auth.audience).toBe("/projects/1/iap");
  });

  test("rejects unknown fields", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-ts-unknown-${Date.now()}`;
    writeFile(
      dir,
      ".devctl/config.yaml",
      `
version: 1
services:
  auth:
    command: echo hi
    mystery: true
`,
    );
    expect(() => load(dir, "")).toThrow(/unknown fields/);
  });

  test("rejects unknown fields in modular profiles", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-ts-prof-${Date.now()}`;
    writeFile(
      dir,
      ".devctl/config.yaml",
      `
version: 1
services:
  api:
    command: echo hi
`,
    );
    writeFile(
      dir,
      ".devctl/profiles/backend.yaml",
      `
services: [api]
mystery: true
`,
    );
    expect(() => load(dir, "")).toThrow(/unknown fields/);
  });

  test("merges per-service proxy routes into the global proxy", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-ts-svc-proxy-${Date.now()}`;
    writeFile(
      dir,
      ".devctl/config.yaml",
      `
version: 1
services:
  api:
    command: echo hi
    proxy:
      - match:
          path: /api
        upstream:
          url: http://127.0.0.1:8000
      - match:
          path: /api/v2
        upstream:
          url: http://127.0.0.1:8001
  worker:
    command: echo hi
    proxy:
      match:
        path: /jobs
      upstream:
        url: http://127.0.0.1:9000
`,
    );
    const cfg = load(dir, "");
    expect(cfg.proxy.routes.map((route) => route.name)).toEqual(["api-1", "api-2", "worker"]);
    expect(cfg.proxy.routes[0]?.upstream.url).toBe("http://127.0.0.1:8000");
    expect(cfg.proxy.routes[2]?.match.path).toBe("/jobs");
  });

  test("loads modular YAML in deterministic filename order", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-ts-order-${Date.now()}`;
    writeFile(dir, ".devctl/config.yaml", "version: 1\n");
    writeFile(dir, ".devctl/services/api.yml", "command: [echo, from-yml]\n");
    writeFile(dir, ".devctl/services/api.yaml", "command: [echo, from-yaml]\n");
    const cfg = load(dir, "");
    // api.yaml sorts before api.yml, so the latter is the deterministic winner.
    expect(cfg.services.api?.command.args).toEqual(["echo", "from-yml"]);
    const command = configDiff(cfg).find((entry) => entry.path === "services.api.command");
    expect(command?.source.endsWith("api.yml")).toBe(true);
    expect(command?.shadowed[0]?.source.endsWith("api.yaml")).toBe(true);
  });

  test("keeps provenance history across main, home, and repository-local layers", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-ts-provenance-${Date.now()}`;
    const devctlHome = `${dir}/home`;
    const previousHome = process.env.DEVCTL_HOME;
    process.env.DEVCTL_HOME = devctlHome;
    try {
      writeFile(dir, ".devctl/config.yaml", "version: 1\nproject:\n  name: main\nservices:\n  api:\n    command: [echo, ok]\n");
      writeFile(devctlHome, "config.local.yaml", "project:\n  name: home\n");
      writeFile(dir, ".devctl/config.local.yaml", "project:\n  name: repo\n");
      const cfg = load(dir, "");
      const entry = configDiff(cfg).find((item) => item.path === "project.name");
      expect(entry?.value).toBe("repo");
      expect(entry?.layer).toBe("repo_local");
      expect(entry?.shadowed.map((item) => item.layer)).toEqual(["main", "home_local"]);
    } finally {
      if (previousHome === undefined) delete process.env.DEVCTL_HOME;
      else process.env.DEVCTL_HOME = previousHome;
    }
  });
});

describe("presence-aware merging", () => {
  test("a template chain lets a service explicitly override false, 0, and an empty collection", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-ts-presence-tmpl-${Date.now()}`;
    writeFile(
      dir,
      ".devctl/config.yaml",
      `
version: 1
templates:
  base:
    shell: true
    dependencies: [db]
    restart:
      policy: on_failure
      max_retries: 5
    startup:
      wait_for_healthy: true
services:
  db:
    command: echo hi
  api:
    extends: base
    command: echo hi
    shell: false
    dependencies: []
    restart:
      max_retries: 0
    startup:
      wait_for_healthy: false
`,
    );
    const cfg = load(dir, "");
    const api = cfg.services.api;
    // Explicit false/0/[] on the service win over the template — not
    // silently discarded because they look the same as "not set".
    expect(api?.shell).toBe(false);
    expect(api?.dependencies).toEqual([]);
    expect(api?.restart.max_retries).toBe(0);
    expect(api?.startup.wait_for_healthy).toBe(false);
    // Fields the service never mentioned within a nested section it *did*
    // partially override still come from the template — nested sections
    // merge field by field, not as an all-or-nothing block.
    expect(api?.restart.policy).toBe("on_failure");
  });

  test("a local overlay can explicitly disable something the main config enabled", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-ts-presence-overlay-disable-${Date.now()}`;
    writeFile(
      dir,
      ".devctl/config.yaml",
      `
version: 1
proxy:
  enabled: true
  listen:
    host: 127.0.0.1
    port: 9000
services:
  api:
    command: echo hi
`,
    );
    writeFile(
      dir,
      ".devctl/config.local.yaml",
      `
proxy:
  enabled: false
`,
    );
    const cfg = load(dir, "");
    expect(cfg.proxy.enabled).toBe(false);
  });

  test("a local overlay touching only part of a section doesn't blow away the rest of it", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-ts-presence-overlay-partial-${Date.now()}`;
    writeFile(
      dir,
      ".devctl/config.yaml",
      `
version: 1
proxy:
  enabled: true
  listen:
    host: 127.0.0.1
    port: 9000
services:
  api:
    command: echo hi
`,
    );
    // The overlay only mentions listen.port — enabled must stay inherited
    // as true instead of being reset to false just because the overlay's
    // proxy section exists and doesn't happen to repeat it.
    writeFile(
      dir,
      ".devctl/config.local.yaml",
      `
proxy:
  listen:
    port: 9001
`,
    );
    const cfg = load(dir, "");
    expect(cfg.proxy.enabled).toBe(true);
    expect(cfg.proxy.listen.port).toBe(9001);
    expect(cfg.proxy.listen.host).toBe("127.0.0.1");
  });

  test("a modular service file can explicitly turn off logging the main file's inline definition turned on", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-ts-presence-modular-${Date.now()}`;
    writeFile(
      dir,
      ".devctl/config.yaml",
      `
version: 1
services:
  api:
    command: echo hi
    logs:
      stdout: true
      stderr: true
`,
    );
    writeFile(
      dir,
      ".devctl/services/api.yaml",
      `
logs:
  stdout: false
  stderr: false
`,
    );
    const cfg = load(dir, "");
    expect(cfg.services.api?.logs.stdout).toBe(false);
    expect(cfg.services.api?.logs.stderr).toBe(false);
  });

  test("a template lets a service explicitly clear an inherited required-env list", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-ts-presence-required-${Date.now()}`;
    writeFile(
      dir,
      ".devctl/config.yaml",
      `
version: 1
templates:
  base:
    environment:
      required: [AUTH_URL]
services:
  api:
    extends: base
    command: echo hi
    environment:
      required: []
`,
    );
    const cfg = load(dir, "");
    expect(cfg.services.api?.environment.required).toEqual([]);
  });
});
