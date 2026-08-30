import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { load } from "./load.ts";

function writeFile(dir: string, rel: string, contents: string): void {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

describe("config load", () => {
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
});
