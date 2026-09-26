// #117: two checkouts of the same config run side by side.
// Known failure until per-checkout ports land: the second checkout's
// service can't bind the port the first one already holds.
import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:net";
import { describeE2E, Sandbox, SCENARIO_TIMEOUT_MS, waitFor } from "./harness.ts";

const SERVER = "Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.HTTP_PORT), fetch: () => new Response(process.cwd()) })";

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

describeE2E("parallel checkouts (#117)", () => {
  const sandboxes: Sandbox[] = [];
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const box of sandboxes.splice(0)) {
      await box.down().catch((err: unknown) => errors.push(err));
    }
    if (errors.length > 0) {
      throw errors[0];
    }
  });

  test.failing("two checkouts of one config each get their own ports and listeners", async () => {
    // A config committed with a pinned port, as most real configs are.
    const config = `version: 1
project:
  name: e2e-parallel
services:
  web:
    command: [${JSON.stringify(process.execPath)}, web.js]
    ports:
      http: ${await freePort()}
    health:
      type: tcp
      interval_seconds: 0.2
`;
    for (const name of ["checkout-a", "checkout-b"]) {
      sandboxes.push(Sandbox.create(name, { "web.js": SERVER, ".devctl/config.yaml": config }));
    }
    for (const box of sandboxes) {
      await box.start(["web"]);
    }
    const ports: number[] = [];
    for (const box of sandboxes) {
      const svc = await waitFor(`web HEALTHY in ${box.dir}`, async () => {
        const status = await box.status();
        return status.services.web?.health === "HEALTHY" ? status.services.web : undefined;
      });
      const port = svc.ports.http ?? 0;
      ports.push(port);
      // Each listener answers for its own checkout.
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe(box.dir);
    }
    expect(new Set(ports).size).toBe(2);
  }, SCENARIO_TIMEOUT_MS);
});
