import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "./config/types.ts";
import { SessionRecovered } from "./events.ts";
import { available } from "./ports.ts";
import { inspectProcess } from "./processes.ts";
import { writePersistedState } from "./storage.ts";
import { Supervisor, diffReload } from "./supervisor.ts";
import { TokenManager, type AccessToken, type TokenProvider } from "./token.ts";

function tmp(): string {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-sup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  process.env.DEVCTL_HOME = dir;
  return dir;
}

function token(): AccessToken {
  return {
    accessToken: "tok",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 60_000),
    audience: "",
    identity: "sa:worker-dev@example.com",
    scopes: [],
  };
}

describe("supervisor snapshot", () => {
  test("records detach and fills identity from stubs", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.google.project_id = "company-dev";
    cfg.services.ping = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "setInterval(() => {}, 1e6)"], shell: false },
    };
    cfg.services.worker = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "process.exit(0)"], shell: false },
      identity: { type: "service_account", mode: "", service_account: "worker-dev@example.com" },
    };
    const provider: TokenProvider = {
      name: "stub",
      fetch: async (identity) => {
        if (!identity.startsWith("sa:")) {
          throw new Error("not sa");
        }
        return token();
      },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({
        gcloudInstalled: true,
        adcAvailable: true,
        userEmail: "dev@example.com",
        projectID: "company-dev",
        projectSource: "configuration",
      }),
      tokens: new TokenManager(60_000, [provider]),
    });
    await sup.refreshIdentity();
    const ident = sup.snapshot().identity;
    expect(ident.user).toBe("dev@example.com");
    expect(ident.adc).toBe(true);
    expect(ident.service_accounts["worker-dev@example.com"]).toBe(true);
    try {
      await sup.start({ services: ["ping"], detach: true });
      expect(sup.snapshot().detached).toBe(true);
      expect(sup.isDetached()).toBe(true);
    } finally {
      await sup.stop(["ping"]);
    }
  }, 15_000);

  test("starts a dependent service while another is already running", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    const basePort = await freePort();
    const plusPort = await freePort();
    cfg.services.base = {
      ...emptyService(),
      command: bunServe(basePort),
      ports: [{ name: "http", value: basePort, auto: false }],
    };
    cfg.services.plus = {
      ...emptyService(),
      command: bunServe(plusPort),
      dependencies: ["base"],
      ports: [{ name: "http", value: plusPort, auto: false }],
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({
        gcloudInstalled: false,
        adcAvailable: false,
        userEmail: "",
        projectID: "",
        projectSource: "",
      }),
    });
    try {
      await sup.start({ services: ["base"] });
      expect(sup.snapshot().services.base?.pid ?? 0).toBeGreaterThan(0);
      await sup.start({ services: ["plus"] });
      expect(sup.snapshot().services.plus?.pid ?? 0).toBeGreaterThan(0);
      expect(["RUNNING", "HEALTHY"]).toContain(sup.snapshot().services.base?.state ?? "");
    } finally {
      await sup.stop(["plus", "base"]);
    }
  }, 15_000);

  test("does not rebind a dependency that is already listening", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    const held = await listenPort();
    const plusPort = await freePort();
    cfg.services.base = {
      ...emptyService(),
      command: bunServe(held.port),
      ports: [{ name: "http", value: held.port, auto: false }],
    };
    cfg.services.plus = {
      ...emptyService(),
      command: bunServe(plusPort),
      dependencies: ["base"],
      ports: [{ name: "http", value: plusPort, auto: false }],
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({
        gcloudInstalled: false,
        adcAvailable: false,
        userEmail: "",
        projectID: "",
        projectSource: "",
      }),
    });
    try {
      await expect(sup.start({ services: ["plus"] })).rejects.toThrow(/blocked|failed to start|port/);
    } finally {
      await held.close();
      await sup.stop(["plus", "base"]);
    }
  });

  test("recovers a matching leftover process and publishes SessionRecovered", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    const port = await freePort();
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", `Bun.serve({port:${port},fetch(){return new Response("ok")}})`],
      stdout: "ignore",
      stderr: "ignore",
    });
    const pid = child.pid ?? 0;
    for (let i = 0; i < 40; i += 1) {
      if (!(await available(port))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    let observed = await inspectProcess(pid);
    for (let i = 0; i < 8 && (!observed || observed.command === ""); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      observed = await inspectProcess(pid);
    }
    expect(observed?.command).toBeTruthy();
    cfg.services.api = {
      ...emptyService(),
      command: bunServe(port),
      ports: [{ name: "http", value: port, auto: false }],
    };
    writePersistedState(dir, {
      session_id: "2026-08-30T00-00-00Z-abc123",
      repo_root: dir,
      profile: "backend",
      processes: [
        {
          name: "api",
          pid,
          command: bunServe(port).args,
          cwd: observed?.cwd ?? "",
          startTime: observed?.startTime ?? "",
          ports: { http: port },
        },
      ],
    });
    const seen: string[] = [];
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({
        gcloudInstalled: false,
        adcAvailable: false,
        userEmail: "",
        projectID: "",
        projectSource: "",
      }),
    });
    sup.subscribe((ev) => seen.push(ev.type));
    try {
      await (sup as unknown as { recoverSession: () => Promise<void> }).recoverSession();
      expect(seen).toContain(SessionRecovered);
      expect(sup.snapshot().services.api?.pid).toBe(pid);
      await sup.stop(["api"]);
    } finally {
      child.kill();
    }
  }, 20_000);

  test("snapshot includes live host system stats", () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    const sys = sup.snapshot().system;
    expect(sys.cpuCount).toBeGreaterThan(0);
    expect(sys.memTotalKB).toBeGreaterThan(0);
    expect(sys.memFreeKB).toBeGreaterThanOrEqual(0);
    expect(sys.memAvailableKB).toBeGreaterThanOrEqual(0);
    expect(sys.memAvailableKB).toBeLessThanOrEqual(sys.memTotalKB);
    expect(sys.platform).toBe(process.platform);
  });

  test("reload diffs command env ports and identity", () => {
    const prev = defaultConfig();
    const next = defaultConfig();
    prev.services.api = { ...emptyService(), command: { args: ["old"], shell: false } };
    next.services.api = { ...emptyService(), command: { args: ["new"], shell: false } };
    const result = diffReload(prev, next);
    expect(result.restart_required).toContain("api");
    expect(result.changes.api).toContain("command");
  });

  test("startTime is set while a service runs and cleared once stopped", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.services.api = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "setInterval(() => {}, 1000)"], shell: false },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.start({ services: ["api"] });
      const running = sup.snapshot().services.api;
      expect(running?.startTime).toBeDefined();
      const startedAt = new Date(running?.startTime ?? "").getTime();
      expect(Math.abs(Date.now() - startedAt)).toBeLessThan(10_000);
      await sup.stop(["api"]);
      expect(sup.snapshot().services.api?.startTime).toBeUndefined();
    } finally {
      await sup.stop(["api"]).catch(() => {});
    }
  }, 15000);

  test("crash restarts are reflected in Runtime.restarts", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.services.flaky = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "process.exit(0)"], shell: false },
      restart: { policy: "always", max_retries: 5, backoff_seconds: 1 },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      void sup.start({ services: ["flaky"] }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 3500));
      expect(sup.snapshot().services.flaky?.restarts ?? 0).toBeGreaterThan(0);
    } finally {
      await sup.stop(["flaky"]).catch(() => {});
    }
  }, 15000);
});

function bunServe(port: number): { args: string[]; shell: boolean } {
  return {
    args: [process.execPath, "-e", `Bun.serve({port:${port},fetch(){return new Response("ok")}})`],
    shell: false,
  };
}

function listenPort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        server.close();
        reject(new Error("no address"));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
    server.on("error", reject);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr === "object") {
          resolve(addr.port);
          return;
        }
        reject(new Error("no address"));
      });
    });
    server.on("error", reject);
  });
}
