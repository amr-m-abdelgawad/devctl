// #118: `devctl test` brings up a throwaway stack, runs a command against
// it, writes a redacted bundle on failure and tears everything down;
// `devctl start --wait` blocks until healthy and exits 6 on timeout.
import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeE2E, Sandbox, SCENARIO_TIMEOUT_MS } from "./harness.ts";

const bun = JSON.stringify(process.execPath);
const SECRET = "sk-live-e2e0123456789abcdef0123456789";

// A marker on every service's command line, to find leftovers with ps.
function files(marker: string): Record<string, string> {
  return {
    "services/web.js": "Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.HTTP_PORT), fetch: () => new Response('ok') })",
    "services/talker.js": "console.log('token=' + process.env.API_TOKEN); setInterval(() => {}, 1000)",
    "check.js": "const port = process.env.DEVCTL_WEB_HTTP_PORT; fetch('http://127.0.0.1:' + port + '/').then(async (r) => { const body = await r.text(); console.log('got ' + body + ' from ' + port); process.exit(body === 'ok' ? 0 : 1) })",
    ".devctl/config.yaml": `version: 1
project:
  name: e2e-test-harness
services:
  web:
    command: [${bun}, services/web.js, ${marker}]
    ports:
      http: auto
    health:
      type: http
      url: http://127.0.0.1:\${services.web.ports.http}/
      interval_seconds: 0.2
  talker:
    command: [${bun}, services/talker.js, ${marker}]
    environment:
      API_TOKEN: ${SECRET}
  never-healthy:
    command: [${bun}, services/web.js, ${marker}]
    ports:
      http: auto
    health:
      type: tcp
      address: 127.0.0.1:1
      interval_seconds: 0.2
`,
  };
}

function leftovers(marker: string): string[] {
  const ps = Bun.spawnSync(["ps", "-eo", "args"], { stdout: "pipe" });
  return ps.stdout.toString().split("\n").filter((line) => line.includes(marker));
}

describeE2E("test/CI harness (#118)", () => {
  const sandboxes: Sandbox[] = [];
  afterEach(async () => {
    for (const box of sandboxes.splice(0)) {
      await box.down();
    }
  });

  test("devctl test runs a command against a throwaway stack and leaves nothing behind", async () => {
    const marker = `devctl-e2e-${process.pid}-${Date.now()}`;
    const box = Sandbox.create("harness-ok", files(marker));
    sandboxes.push(box);
    const run = await box.cli(["test", "--services", "web,talker", "--timeout", "60s", "--", process.execPath, "check.js"]);
    expect(run.stdout).toMatch(/got ok from \d+/);
    expect(existsSync(join(box.dir, "devctl-artifacts"))).toBe(false);
    expect(JSON.parse((await box.cli(["instances", "--json"])).stdout)).toEqual([]);
    expect(leftovers(marker)).toEqual([]);
  }, SCENARIO_TIMEOUT_MS);

  test("a failing command's exit code comes back, with a redacted bundle", async () => {
    const marker = `devctl-e2e-${process.pid}-${Date.now()}`;
    const box = Sandbox.create("harness-fail", files(marker));
    sandboxes.push(box);
    const run = await box.cli(["test", "--services", "web,talker", "--timeout", "60s", "--artifacts", "out", "--", "sh", "-c", "exit 3"], { allowFail: true });
    expect(run.code).toBe(3);
    const dir = join(box.dir, "out");
    const names = readdirSync(dir).sort();
    expect(names).toEqual(expect.arrayContaining(["config-diff.json", "doctor.json", "logs.ndjson", "status.json", "traffic.json", "versions.txt"]));
    // The talker printed the secret: the bundle has the line, not the value.
    const logs = readFileSync(join(dir, "logs.ndjson"), "utf8");
    expect(logs).toContain("token=********");
    for (const name of names) {
      expect(readFileSync(join(dir, name), "utf8")).not.toContain(SECRET);
    }
    expect(leftovers(marker)).toEqual([]);
  }, SCENARIO_TIMEOUT_MS);

  test("start --wait exits 6 naming the service that never became healthy", async () => {
    const marker = `devctl-e2e-${process.pid}-${Date.now()}`;
    const box = Sandbox.create("harness-wait", files(marker));
    sandboxes.push(box);
    const ok = await box.cli(["start", "web", "--wait", "--timeout", "30s"]);
    expect(ok.stdout).toContain("ready: web");
    const late = await box.cli(["start", "never-healthy", "--wait", "--timeout", "2s"], { allowFail: true });
    expect(late.code).toBe(6);
    expect(late.stderr).toContain("services not ready after 2s: never-healthy");
  }, SCENARIO_TIMEOUT_MS);
});
