// #117: two checkouts of the same config run side by side. The first takes
// port slot 0 (configured ports); the second takes slot 1 (every fixed port
// and listener +100). Both share one DEVCTL_HOME, where the slot registry is.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { processAlive, readRepoLock } from "../src/adapters/storage/storage.ts";
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

// A config committed with pinned ports, as most real configs are: the
// service's port and the proxy listener are the same in every checkout.
async function config(): Promise<string> {
  return `version: 1
project:
  name: e2e-parallel
proxy:
  enabled: true
  listen:
    port: ${await freePort()}
services:
  web:
    command: [${JSON.stringify(process.execPath)}, web.js]
    ports:
      http: ${await freePort()}
    health:
      type: tcp
      interval_seconds: 0.2
`;
}

type InstanceRow = { slot: number; offset: number; repoRoot: string; status: string; ports?: Record<string, number> };

describeE2E("parallel checkouts (#117)", () => {
  const sandboxes: Sandbox[] = [];
  const homes: string[] = [];
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const box of sandboxes.splice(0)) {
      await box.down().catch((err: unknown) => errors.push(err));
    }
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
    if (errors.length > 0) {
      throw errors[0];
    }
  });

  function sharedHome(): string {
    const home = mkdtempSync(join("/tmp", "dctl-home-"));
    homes.push(home);
    return home;
  }

  test("two checkouts of one config each get their own ports and listeners", async () => {
    const home = sharedHome();
    const cfg = await config();
    for (const name of ["checkout-a", "checkout-b"]) {
      sandboxes.push(Sandbox.create(name, { "web.js": SERVER, ".devctl/config.yaml": cfg }, { home }));
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
    expect(ports[1]).toBe((ports[0] ?? 0) + 100);

    const [a, b] = sandboxes as [Sandbox, Sandbox];
    expect((await b.cli(["status"])).stdout).toContain("INSTANCE: slot 1 (ports +100)");
    expect((await a.cli(["status"])).stdout).not.toContain("INSTANCE:");

    const rows = JSON.parse((await a.cli(["instances", "--json"])).stdout) as InstanceRow[];
    expect(rows.map((row) => [row.slot, row.repoRoot, row.status])).toEqual([
      [0, a.dir, "running"],
      [1, b.dir, "running"],
    ]);
    expect((rows[1]?.ports?.proxy ?? 0) - (rows[0]?.ports?.proxy ?? 0)).toBe(100);

    // A full down frees the slot; the next checkout to start reuses it.
    await b.cli(["down"]);
    const after = JSON.parse((await a.cli(["instances", "--json"])).stdout) as InstanceRow[];
    expect(after.map((row) => row.slot)).toEqual([0]);
  }, SCENARIO_TIMEOUT_MS);

  test("instances prune stops the stack of a deleted checkout and frees its slot", async () => {
    const home = sharedHome();
    const cfg = await config();
    const keep = Sandbox.create("prune-keep", { "web.js": SERVER, ".devctl/config.yaml": cfg }, { home });
    const gone = Sandbox.create("prune-gone", { "web.js": SERVER, ".devctl/config.yaml": cfg }, { home });
    sandboxes.push(keep);
    await keep.start(["web"]);
    await gone.start(["web"]);
    const goneService = await waitFor("web running in the checkout to delete", async () => {
      const status = await gone.status();
      return (status.services.web?.pid ?? 0) > 0 ? status.services.web : undefined;
    });
    const previousHome = process.env.DEVCTL_HOME;
    process.env.DEVCTL_HOME = home;
    const supervisorPid = readRepoLock(gone.dir)?.pid ?? 0;
    if (previousHome === undefined) {
      delete process.env.DEVCTL_HOME;
    } else {
      process.env.DEVCTL_HOME = previousHome;
    }
    expect(supervisorPid).toBeGreaterThan(0);

    // The worktree is deleted while its stack is still up.
    rmSync(gone.dir, { recursive: true, force: true });
    const listed = JSON.parse((await keep.cli(["instances", "--json"])).stdout) as InstanceRow[];
    expect(listed.find((row) => row.repoRoot === gone.dir)?.status).toBe("missing");

    const pruned = await keep.cli(["instances", "prune"]);
    expect(pruned.stdout).toContain(`pruned slot 1 (${gone.dir}); stopped its services and supervisor`);
    await waitFor("the deleted checkout's service and supervisor to exit", async () => !processAlive(goneService.pid) && !processAlive(supervisorPid));
    const remaining = JSON.parse((await keep.cli(["instances", "--json"])).stdout) as InstanceRow[];
    expect(remaining.map((row) => row.repoRoot)).toEqual([keep.dir]);
  }, SCENARIO_TIMEOUT_MS);
});
