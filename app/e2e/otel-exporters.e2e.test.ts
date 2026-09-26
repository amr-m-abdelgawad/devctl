// #112: stock OpenTelemetry exporters (Python and Node, protobuf over HTTP)
// deliver spans and logs to the receiver with no per-service configuration.
// Needs `bash e2e/setup.sh` for the pinned exporter packages.
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { bodyText, describeE2E, FIXTURES_DIR, PYTHON_BIN, Sandbox, SCENARIO_TIMEOUT_MS, waitFor } from "./harness.ts";

const NODE_FIXTURE = join(FIXTURES_DIR, "otel-node");
const PYTHON_FIXTURE = join(FIXTURES_DIR, "otel-python");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
    });
  });
}

function requireSetup(): void {
  const missing = [
    existsSync(PYTHON_BIN) ? "" : PYTHON_BIN,
    existsSync(join(NODE_FIXTURE, "node_modules", "@opentelemetry")) ? "" : join(NODE_FIXTURE, "node_modules"),
  ].filter((path) => path !== "");
  if (missing.length > 0) {
    throw new Error(`pinned exporters not installed (${missing.join(", ")}); run: bash e2e/setup.sh`);
  }
}

describeE2E("stock OpenTelemetry exporters (#112)", () => {
  let sandbox: Sandbox | undefined;
  afterEach(async () => {
    await sandbox?.down();
    sandbox = undefined;
  });

  for (const lang of ["python", "node"] as const) {
    test(`${lang}: spans and logs arrive over OTLP/HTTP protobuf`, async () => {
      requireSetup();
      const command = lang === "python"
        ? `[${JSON.stringify(PYTHON_BIN)}, ${JSON.stringify(join(PYTHON_FIXTURE, "emit.py"))}]`
        : `[node, ${JSON.stringify(join(NODE_FIXTURE, "emit.mjs"))}]`;
      const workdir = lang === "python" ? PYTHON_FIXTURE : NODE_FIXTURE;
      sandbox = Sandbox.create(`otel-${lang}`, {
        ".devctl/config.yaml": `version: 1
project:
  name: e2e-otel-${lang}
services:
  emitter:
    command: ${command}
    working_dir: ${JSON.stringify(workdir)}
telemetry:
  otlp:
    enabled: true
    listen:
      host: 127.0.0.1
      port: ${await freePort()}
`,
      });
      await sandbox.start(["emitter"]);
      const box = sandbox;
      const record = await waitFor(`an OTLP log record from the ${lang} exporter`, async () =>
        (await box.logs()).find((rec) => rec.source === "otlp" && bodyText(rec) === `hello from ${lang} exporter`), 45_000);
      expect(record.service).toBe("emitter");
      expect(record.traceId).toMatch(/^[0-9a-f]{32}$/);
      const trace = await box.cli(["logs", "--trace", record.traceId ?? ""]);
      expect(trace.stdout).toContain(`${lang}-span`);
      // The exporter never reported a failed export on its own stderr.
      const stderr = (await box.logs(["emitter"])).filter((rec) => rec.source === "stderr").map(bodyText);
      expect(stderr.filter((line) => /fail|error/i.test(line))).toEqual([]);
    }, SCENARIO_TIMEOUT_MS);
  }
});
