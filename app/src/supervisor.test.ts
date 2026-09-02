import { createServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "./config/types.ts";
import { ConfigurationReloadFailed, SessionRecovered } from "./events.ts";
import { MCP_TOOLS } from "./mcp/tools.ts";
import { processAlive, readPersistedState, writePersistedState } from "./storage.ts";
import { Supervisor, diffReload } from "./supervisor.ts";
import { saveTuiPreferences } from "./tui/tui-config.ts";
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
  test("explicit shutdown stops services even after a detached start", async () => {
    const cfg = defaultConfig();
    cfg.repoRoot = tmp();
    cfg.logs.persistence.enabled = false;
    const sup = new Supervisor(cfg);
    const calls: string[][] = [];
    (sup as unknown as { detached: boolean }).detached = true;
    sup.stop = async (services: string[]) => {
      calls.push(services);
    };

    await sup.shutdown(true);

    expect(calls).toEqual([[]]);
  });

  test("records detach and fills identity from stubs", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 1;
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
    cfg.shutdown.grace_seconds = 1;
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
    cfg.shutdown.grace_seconds = 1;
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
    cfg.shutdown.grace_seconds = 1;
    cfg.services.api = {
      ...emptyService(),
      command: { args: ["python", "main.py"], shell: false },
    };
    const leftover = {
      pid: 4242,
      command: "python main.py",
      cwd: "",
    };
    writePersistedState(dir, {
      session_id: "2026-08-30T00-00-00Z-abc123",
      repo_root: dir,
      profile: "backend",
      processes: [
        {
          name: "api",
          pid: leftover.pid,
          command: ["python", "main.py"],
          cwd: leftover.cwd,
          startTime: "",
          ports: { http: 18000 },
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
      processAlive: (pid) => pid === leftover.pid,
      inspectProcess: async (pid) => (pid === leftover.pid ? leftover : undefined),
    });
    sup.subscribe((ev) => seen.push(ev.type));
    await (sup as unknown as { recoverSession: () => Promise<void> }).recoverSession();
    expect(seen).toContain(SessionRecovered);
    expect(sup.snapshot().services.api?.pid).toBe(leftover.pid);
  });

  test("snapshot includes live host system stats", () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 1;
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
    cfg.shutdown.grace_seconds = 1;
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

  test("a losing supervisor never deletes a live peer's bound socket", async () => {
    // Regression for the startup race: two `devctl start` invocations for the
    // same repo used to check "does a socket file exist" before checking
    // "is the lock already held" — so a losing process could unlink a
    // still-live peer's socket on its way to discovering it had lost.
    // Injected primitives force the interleaving deterministically instead
    // of relying on real concurrent processes.
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    let unlinkCalled = false;
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
      acquireLock: () => {
        throw new Error("supervisor already running (pid 4242)");
      },
      socketExists: () => true,
      unlinkSocket: () => {
        unlinkCalled = true;
      },
    });
    await expect(sup.run()).rejects.toThrow(/already running/);
    expect(unlinkCalled).toBe(false);
  });

  test("removes a stale socket only after winning the lock, never before", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    const events: string[] = [];
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
      acquireLock: () => {
        events.push("lock");
        return { release: () => events.push("release") };
      },
      socketExists: () => {
        events.push("check");
        return true;
      },
      unlinkSocket: () => {
        events.push("unlink");
      },
    });
    try {
      await sup.run();
      expect(events[0]).toBe("lock");
      expect(events.slice(1)).toEqual(["check", "unlink", "check", "unlink"]);
    } finally {
      await sup.shutdown(false);
    }
  }, 15_000);

  test("stop cancels a pending crash-restart timer instead of the service coming back", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 1;
    cfg.services.flaky = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "process.exit(0)"], shell: false },
      restart: { policy: "always", max_retries: 5, backoff_seconds: 3 },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      void sup.start({ services: ["flaky"] }).catch(() => {});
      // Let the first crash happen so onExit() schedules its 3s backoff restart.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(sup.snapshot().services.flaky?.state).toBe("RESTARTING");
      await sup.stop(["flaky"]);
      expect(sup.snapshot().services.flaky?.state).toBe("STOPPED");
      // Wait past the 3s window the cancelled timer would have fired in.
      await new Promise((resolve) => setTimeout(resolve, 3200));
      expect(sup.snapshot().services.flaky?.state).toBe("STOPPED");
      expect(sup.snapshot().services.flaky?.pid ?? 0).toBe(0);
    } finally {
      await sup.stop(["flaky"]).catch(() => {});
    }
  }, 15_000);

  test("fail and shutdown cancel pending restart timers immediately", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    const internals = sup as unknown as {
      restartTimers: Map<string, ReturnType<typeof setTimeout>>;
      scheduleRestart: (name: string, delayMs: number, action: () => void) => void;
      fail: (name: string, err: unknown) => Promise<void>;
    };
    let fired = false;
    internals.scheduleRestart("ghost", 60_000, () => {
      fired = true;
    });
    expect(internals.restartTimers.size).toBe(1);
    await internals.fail("ghost", new Error("boom"));
    expect(internals.restartTimers.size).toBe(0);

    internals.scheduleRestart("ghost2", 60_000, () => {
      fired = true;
    });
    expect(internals.restartTimers.size).toBe(1);
    await sup.shutdown(false);
    expect(internals.restartTimers.size).toBe(0);
    expect(fired).toBe(false);
  });

  test("a startup health-check failure is not resurrected by its own kill", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 1;
    cfg.services.neverhealthy = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "setInterval(() => {}, 1000)"], shell: false },
      // Nothing listens on port 1, so this always fails fast (ECONNREFUSED).
      health: { ...emptyService().health, type: "tcp", address: "127.0.0.1:1", interval_seconds: 1, timeout_seconds: 1 },
      startup: { wait_for_healthy: true, timeout_seconds: 1 },
      restart: { policy: "always", max_retries: 5, backoff_seconds: 1 },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await expect(sup.start({ services: ["neverhealthy"] })).rejects.toThrow();
      expect(sup.snapshot().services.neverhealthy?.state).toBe("FAILED");
      // Poll for a few seconds rather than checking once at a fixed delay: a
      // still-buggy version doesn't get stuck RESTARTING, it oscillates
      // (restart -> fails health again -> restart...), so a single snapshot
      // at an arbitrary later time can land on a FAILED tick between cycles
      // and miss the bug. A nonzero pid at any point proves a new process
      // was spawned, i.e. the kill in fail() was treated as a crash to
      // restart from.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const rt = sup.snapshot().services.neverhealthy;
        expect(rt?.pid ?? 0).toBe(0);
        expect(rt?.state).toBe("FAILED");
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    } finally {
      await sup.stop(["neverhealthy"]).catch(() => {});
    }
  }, 15_000);

  test("detach shutdown re-persists current state, correcting whatever was recorded before it", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 1;
    cfg.services.longrunner = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "setInterval(() => {}, 1000)"], shell: false },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    let pid = 0;
    try {
      await sup.start({ services: ["longrunner"], detach: true });
      pid = sup.snapshot().services.longrunner?.pid ?? 0;
      expect(pid).toBeGreaterThan(0);
      // Simulate state.json having gone stale relative to the supervisor's
      // in-memory state (e.g. from an earlier un-persisted mutation) —
      // shutdown() must overwrite it with the truth on its way out, not
      // trust whatever was already on disk.
      writePersistedState(dir, { session_id: "stale", repo_root: dir, profile: "", processes: [] });
      await sup.shutdown(false);
      // Detach means "leave it running", not "kill it" — the process must
      // still be alive after a detach shutdown.
      expect(processAlive(pid)).toBe(true);
      const persisted = readPersistedState(dir);
      const rec = persisted?.processes.find((p) => p.name === "longrunner");
      expect(rec?.pid).toBe(pid);
    } finally {
      if (pid > 0) {
        process.kill(pid, "SIGKILL");
      }
    }
  }, 15_000);

  test("config_snapshot returns the current in-memory config and is never exposed to MCP", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.project.name = "snapshot-test";
    cfg.logs.persistence.enabled = false;
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    const snap = (await sup.dispatch("config_snapshot", null)) as { project: { name: string } };
    expect(snap.project.name).toBe("snapshot-test");
    expect(MCP_TOOLS.some((tool) => tool.name.includes("config_snapshot"))).toBe(false);
  });

  test("a failed reload publishes ConfigurationReloadFailed and keeps the previous config", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    const configPath = join(dir, ".devctl", "config.yaml");
    writeFileSync(
      configPath,
      `version: 1
project:
  name: before-reload
services:
  api:
    command: [echo, ok]
`,
    );
    const { load } = await import("./config/index.ts");
    const cfg = load(dir, "");
    cfg.logs.persistence.enabled = false;
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    const seen: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    sup.subscribe((ev) => seen.push({ type: ev.type, payload: ev.payload }));

    // Break the file on disk without going through the supervisor.
    writeFileSync(configPath, "version: [\n");
    await expect(sup.reload()).rejects.toThrow();

    const failure = seen.find((ev) => ev.type === ConfigurationReloadFailed);
    expect(failure).toBeDefined();
    expect(String(failure?.payload?.error ?? "")).toMatch(/invalid YAML/);

    const snap = (await sup.dispatch("config_snapshot", null)) as { project: { name: string } };
    expect(snap.project.name).toBe("before-reload");
  });

  test("lazy, sticky proxy: startup never binds it, the first start does, and explicit stop sticks across further starts", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 1;
    cfg.proxy.enabled = true;
    cfg.proxy.listen = { host: "127.0.0.1", port: await freePort() };
    cfg.services.api = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "setInterval(() => {}, 1000)"], shell: false },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.run();
      expect(sup.snapshot().proxy.running).toBe(false);

      // The first start() auto-starts it.
      await sup.start({ services: ["api"] });
      expect(sup.snapshot().proxy.running).toBe(true);

      // Explicit proxy_stop suppresses it — not just for now, but for every
      // subsequent start() until an explicit proxy_start.
      await sup.dispatch("proxy_stop", null);
      expect(sup.snapshot().proxy.running).toBe(false);
      await sup.stop(["api"]);
      await sup.start({ services: ["api"] });
      expect(sup.snapshot().proxy.running).toBe(false);

      // reload() must not clear that suppression on its own.
      await sup.reload().catch(() => undefined);
      expect(sup.snapshot().proxy.running).toBe(false);

      // Only an explicit proxy_start clears it.
      await sup.dispatch("proxy_start", null);
      expect(sup.snapshot().proxy.running).toBe(true);
    } finally {
      await sup.stop(["api"]).catch(() => {});
      await sup.shutdown(false);
    }
  }, 15_000);

  test("a saved mcp_enabled preference starts MCP at daemon boot, independent of which client spawned it", async () => {
    const dir = tmp();
    const port = await freePort();
    // Written directly to the user's tui.json, exactly as the TUI's own
    // "toggle MCP" persists it — nothing here is CLI- or TUI-specific,
    // proving the daemon applies it on its own at boot.
    saveTuiPreferences({ mcp_enabled: true, mcp_port: port });
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.run();
      const snap = sup.snapshot();
      expect(snap.mcp?.running).toBe(true);
      expect(snap.mcp?.port).toBe(port);
    } finally {
      await sup.shutdown(false);
    }
  }, 15_000);

  test("no saved mcp preference leaves MCP off at boot", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.run();
      expect(sup.snapshot().mcp?.running).toBe(false);
    } finally {
      await sup.shutdown(false);
    }
  }, 15_000);

  test("crash restarts are reflected in Runtime.restarts", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 1;
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
