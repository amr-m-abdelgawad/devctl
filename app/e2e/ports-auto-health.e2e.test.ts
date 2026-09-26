// #111: http, grpc and tcp health checks follow `ports: auto`.
import { afterEach, expect, test } from "bun:test";
import { describeE2E, Sandbox, SCENARIO_TIMEOUT_MS, waitFor } from "./harness.ts";

const bun = JSON.stringify(process.execPath);
const HTTP_SERVER = "Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.HTTP_PORT), fetch: () => new Response('ok') })";
const TCP_SERVER = "require('node:net').createServer().listen(Number(process.env.HTTP_PORT), '127.0.0.1')";
const GRPC_SERVER = [
  "const server = require('node:http2').createServer();",
  "server.on('stream', (stream) => { stream.on('data', () => {}); stream.on('end', () => {",
  "  stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });",
  "  stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));",
  "  stream.end(Buffer.from([0, 0, 0, 0, 2, 0x08, 1]));",
  "}); });",
  "server.listen(Number(process.env.GRPC_PORT), '127.0.0.1');",
].join(" ");

// Service code lives in files: the config validator rejects `;` inside a
// command array even though arrays never reach a shell (see the
// command-array scenario in config-validate.e2e.test.ts).
const FILES = {
  "services/web.js": HTTP_SERVER,
  "services/rpc.js": GRPC_SERVER,
  "services/raw.js": TCP_SERVER,
};

const CONFIG = `version: 1
project:
  name: e2e-ports-auto
services:
  web:
    command: [${bun}, services/web.js]
    ports:
      http: auto
    health:
      type: http
      url: http://127.0.0.1:\${services.web.ports.http}/
      interval_seconds: 0.2
  rpc:
    command: [${bun}, services/rpc.js]
    ports:
      grpc: auto
    health:
      type: grpc
      address: 127.0.0.1:\${services.rpc.ports.grpc}
      interval_seconds: 0.2
  raw:
    command: [${bun}, services/raw.js]
    ports:
      http: auto
    health:
      type: tcp
      interval_seconds: 0.2
`;

describeE2E("ports: auto health checks (#111)", () => {
  let sandbox: Sandbox | undefined;
  afterEach(async () => {
    await sandbox?.down();
    sandbox = undefined;
  });

  test("every probe reaches its service's assigned port", async () => {
    sandbox = Sandbox.create("ports-auto", { ...FILES, ".devctl/config.yaml": CONFIG });
    await sandbox.cli(["config", "validate"]);
    await sandbox.start(["web", "rpc", "raw"]);
    const box = sandbox;
    const snapshot = await waitFor("all three services HEALTHY", async () => {
      const status = await box.status();
      return ["web", "rpc", "raw"].every((name) => status.services[name]?.health === "HEALTHY") ? status : undefined;
    });
    // Assigned, not pinned: each got a real port of its own.
    const ports = [snapshot.services.web?.ports.http, snapshot.services.rpc?.ports.grpc, snapshot.services.raw?.ports.http];
    expect(ports.every((port) => typeof port === "number" && port > 0)).toBe(true);
    expect(new Set(ports).size).toBe(3);
  }, SCENARIO_TIMEOUT_MS);
});
