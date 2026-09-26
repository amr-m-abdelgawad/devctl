import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "../../domain/config/types.ts";
import { extractHelmEnv, helmConfigIssues, loadHelmEnvironment } from "./helm.ts";

const DEPLOYMENT = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  template:
    spec:
      containers:
        - name: api
          env:
            - name: LOG_LEVEL
              value: info
            - name: PUBLIC_URL
              value: https://api.example.com
            - name: API_URL
              value: {{ .Values.apiUrl | quote }}
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: db
                  key: password
          {{- if .Values.extra }}
            - name: EXTRA
              value: "yes"
          {{- end }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
spec:
  template:
    spec:
      containers:
        - name: worker
          env:
            - name: ROLE
              value: worker
`;

describe("helm env extraction", () => {
  test("reads literal container env and skips templates, secrets, and other workloads", () => {
    const selected = extractHelmEnv([{ name: "deployment.yaml", text: DEPLOYMENT }], "Deployment/api");
    expect(selected.foundResource).toBe(true);
    expect(selected.values).toEqual({
      LOG_LEVEL: "info",
      PUBLIC_URL: "https://api.example.com",
      EXTRA: "yes",
    });

    const all = extractHelmEnv([{ name: "deployment.yaml", text: DEPLOYMENT }], "");
    expect(all.values.ROLE).toBe("worker");
    expect(all.values.LOG_LEVEL).toBe("info");
    expect(all.values.API_URL).toBeUndefined();
    expect(all.values.DB_PASSWORD).toBeUndefined();
  });

  test("reads a values.yaml env map", () => {
    const text = `
      env:
        FROM_MAP: "yes"
        PORT: 8080
        SKIPPED: "{{ .Release.Name }}"
      extraEnv:
        - name: FROM_LIST
          value: list
    `;
    expect(extractHelmEnv([{ name: "values.yaml", text, values: true }], "").values).toEqual({
      FROM_MAP: "yes",
      PORT: "8080",
      FROM_LIST: "list",
    });
  });
});

describe("helm env config", () => {
  test("reads a chart, lets the template win, and ignores subcharts", () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-helm-"));
    const chart = join(dir, "chart");
    mkdirSync(join(chart, "templates"), { recursive: true });
    mkdirSync(join(chart, "charts", "dep", "templates"), { recursive: true });
    writeFileSync(join(chart, "Chart.yaml"), "apiVersion: v2\nname: api\n");
    writeFileSync(join(chart, "values.yaml"), "env:\n  LOG_LEVEL: debug\n  FROM_VALUES: values\n");
    writeFileSync(join(chart, "templates", "deployment.yaml"), `
      apiVersion: apps/v1
      kind: Deployment
      metadata:
        name: api
      spec:
        template:
          spec:
            containers:
              - name: api
                env:
                  - name: LOG_LEVEL
                    value: info
    `);
    writeFileSync(join(chart, "charts", "dep", "templates", "deployment.yaml"), `
      kind: Deployment
      metadata:
        name: dep
      spec:
        template:
          spec:
            containers:
              - env:
                  - name: FROM_SUBCHART
                    value: no
    `);
    const values = loadHelmEnvironment(dir, "services.api.environment.helm", {
      path: "chart",
      resource: "Deployment/api",
    });
    expect(values).toEqual({ LOG_LEVEL: "info", FROM_VALUES: "values" });
  });

  test("rejects a path outside the repo, a missing workload, and a file with no literals", () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-helm-bad-"));
    writeFileSync(join(dir, "empty.yaml"), "kind: Deployment\nmetadata:\n  name: api\n");
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.services.api = emptyService();
    cfg.services.api.environment.helm = { path: "../secret.yaml", resource: "" };
    expect(helmConfigIssues(cfg).join("\n")).toContain("must stay inside the repository");

    cfg.services.api.environment.helm = { path: "empty.yaml", resource: "Deployment/api" };
    expect(helmConfigIssues(cfg).join("\n")).toContain("no literal env values");

    cfg.services.api.environment.helm = { path: "empty.yaml", resource: "Deployment/other" };
    expect(helmConfigIssues(cfg).join("\n")).toContain('resource "Deployment/other" was not found');

    cfg.services.api.environment.helm = { path: "missing.yaml", resource: "" };
    expect(helmConfigIssues(cfg).join("\n")).toContain("not found: missing.yaml");

    cfg.services.api.environment.helm = { path: "empty.yaml", resource: "not an address" };
    expect(helmConfigIssues(cfg).join("\n")).toContain("must look like Kind or Kind/name");
  });

  test("rejects a directory symlink that leaves the repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-helm-link-"));
    const outside = mkdtempSync(join(tmpdir(), "devctl-helm-outside-"));
    writeFileSync(join(outside, "values.yaml"), "env:\n  LEAK: no\n");
    symlinkSync(outside, join(dir, "chart"));
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.services.api = emptyService();
    cfg.services.api.environment.helm = { path: "chart", resource: "" };
    expect(helmConfigIssues(cfg).join("\n")).toContain("must stay inside the repository");
  });
});
