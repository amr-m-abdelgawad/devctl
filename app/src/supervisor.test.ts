import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyHealth, emptyService } from "./config/types.ts";
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

describe("client_env forwarding", () => {
  test("a client's env applies on start, stays sticky through a client_env-less restart, and a fresh client's env replaces it", async () => {
    const dir = tmp();
    const outFile = join(dir, "marker.txt");
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 1;
    cfg.services.api = {
      ...emptyService(),
      environment: { vars: { OUT_FILE: outFile }, required: [], defaults: {} },
      command: {
        args: [
          process.execPath,
          "-e",
          "require('fs').writeFileSync(process.env.OUT_FILE, process.env.DEVCTL_TEST_MARKER ?? 'unset'); setInterval(() => {}, 1000);",
        ],
        shell: false,
      },
    };
    const originalMarker = process.env.DEVCTL_TEST_MARKER;
    // Simulates the daemon's own (stale) process.env — the fallback a
    // service must use when no real client has ever supplied one for it.
    process.env.DEVCTL_TEST_MARKER = "daemon-own-env";
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      // An MCP-style start (no client_env) falls back to the daemon's env.
      await sup.start({ services: ["api"] });
      await waitForFileContent(outFile, "daemon-own-env");

      // A real client's restart replaces the fallback for this service.
      await sup.restart(["api"], { clientEnv: { DEVCTL_TEST_MARKER: "client-one" } });
      await waitForFileContent(outFile, "client-one");

      // A crash/health-triggered restart has no client attached and passes
      // no client_env — it must reuse the last real client's env, not fall
      // back to the daemon's own.
      await sup.restart(["api"]);
      await waitForFileContent(outFile, "client-one");

      // A second, later client's env replaces the stored one again.
      await sup.restart(["api"], { clientEnv: { DEVCTL_TEST_MARKER: "client-two" } });
      await waitForFileContent(outFile, "client-two");
    } finally {
      await sup.stop(["api"]).catch(() => {});
      await sup.shutdown(false);
      if (originalMarker === undefined) {
        delete process.env.DEVCTL_TEST_MARKER;
      } else {
        process.env.DEVCTL_TEST_MARKER = originalMarker;
      }
    }
  }, 15_000);
});

describe("restart-count bookkeeping", () => {
  test("a manual stop resets the service's restart count", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 0.2;
    cfg.services.api = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "setInterval(() => {}, 1000)"], shell: false },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.start({ services: ["api"] });
      (sup as unknown as { bumpRestartCount: (name: string, n: number) => void }).bumpRestartCount("api", 4);
      expect(sup.snapshot().services.api?.restarts).toBe(4);

      await sup.stop(["api"]);

      expect(sup.snapshot().services.api?.restarts).toBe(0);
    } finally {
      await sup.stop(["api"]).catch(() => {});
    }
  }, 10_000);

  test("a manual start resets the service's restart count", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 0.2;
    cfg.services.api = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "setInterval(() => {}, 1000)"], shell: false },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.start({ services: ["api"] });
      await sup.stop(["api"]);
      // stop() already resets the count on its own (previous test) — bump it
      // again here so this test attributes the reset specifically to the
      // next start(), not to the stop() that preceded it.
      (sup as unknown as { bumpRestartCount: (name: string, n: number) => void }).bumpRestartCount("api", 4);
      expect(sup.snapshot().services.api?.restarts).toBe(4);

      await sup.start({ services: ["api"] });

      expect(sup.snapshot().services.api?.restarts).toBe(0);
    } finally {
      await sup.stop(["api"]).catch(() => {});
    }
  }, 10_000);

  test("an automatic (health-triggered) restart preserves the restart count instead of resetting it", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 0.2;
    cfg.services.api = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "setInterval(() => {}, 1000)"], shell: false },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.start({ services: ["api"] });
      (sup as unknown as { bumpRestartCount: (name: string, n: number) => void }).bumpRestartCount("api", 2);

      // Same shape maybeRestartUnhealthy/armRestart use for their own
      // internal restart — never a real client's.
      await sup.restart(["api"], { auto: true });

      expect(sup.snapshot().services.api?.restarts).toBe(2);
    } finally {
      await sup.stop(["api"]).catch(() => {});
    }
  }, 10_000);

  test("organically triggered health restarts accumulate to max_retries without the count getting wiped mid-cycle", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 0.2;
    cfg.services.api = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "setInterval(() => {}, 1000)"], shell: false },
      restart: { policy: "on_failure", max_retries: 2, backoff_seconds: 0.02 },
      health: {
        ...emptyHealth(),
        type: "command",
        command: { args: [process.execPath, "-e", "process.exit(1)"], shell: false },
        interval_seconds: 0.03,
        timeout_seconds: 1,
      },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      void sup.start({ services: ["api"] }).catch(() => {});

      await waitFor(() => (sup.snapshot().services.api?.restarts ?? -1) === 2, 10_000);
      // If maybeRestartUnhealthy's real call site ever dropped the auto
      // flag, that restart's own start() would immediately erase the count
      // it just bumped, and it would never be observed holding at the limit
      // — it would instead keep oscillating back toward 0.
      await sleep(300);
      expect(sup.snapshot().services.api?.restarts).toBe(2);
    } finally {
      await sup.stop(["api"]).catch(() => {});
    }
  }, 15_000);

  test("sustained healthy operation forgives a service's past restarts", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 0.2;
    cfg.services.api = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "setInterval(() => {}, 1000)"], shell: false },
      health: {
        ...emptyHealth(),
        type: "command",
        command: { args: [process.execPath, "-e", "process.exit(0)"], shell: false },
        interval_seconds: 0.02,
        timeout_seconds: 1,
      },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.start({ services: ["api"] });
      (sup as unknown as { bumpRestartCount: (name: string, n: number) => void }).bumpRestartCount("api", 3);
      expect(sup.snapshot().services.api?.restarts).toBe(3);

      await waitFor(() => (sup.snapshot().services.api?.restarts ?? -1) === 0, 5000);
    } finally {
      await sup.stop(["api"]).catch(() => {});
    }
  }, 10_000);
});

describe("persisted state durability", () => {
  test("a crash-restarted service's new pid is persisted, not just held in memory", async () => {
    const dir = tmp();
    const marker = join(dir, "crashed-once.marker");
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 0.2;
    cfg.services.flaky = {
      ...emptyService(),
      environment: { vars: { CRASH_MARKER: marker }, required: [], defaults: {} },
      command: {
        args: [
          process.execPath,
          "-e",
          "const fs=require('fs'); const m=process.env.CRASH_MARKER; if(!fs.existsSync(m)){fs.writeFileSync(m,'1'); process.exit(1);} setInterval(()=>{},1000);",
        ],
        shell: false,
      },
      restart: { policy: "always", max_retries: 5, backoff_seconds: 0.05 },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      void sup.start({ services: ["flaky"] }).catch(() => {});

      // Crash-restart's respawn never goes through start() (which used to be
      // the only place that persisted) — it calls startOne() directly, so
      // without startOne() persisting its own successful spawn the new pid
      // would never make it to disk at all.
      await waitFor(() => (sup.snapshot().services.flaky?.restarts ?? 0) > 0 && (sup.snapshot().services.flaky?.pid ?? 0) > 0);
      const pid = sup.snapshot().services.flaky?.pid ?? 0;
      expect(pid).toBeGreaterThan(0);

      const persisted = readPersistedState(dir);
      expect(persisted?.processes.find((p) => p.name === "flaky")?.pid).toBe(pid);
    } finally {
      await sup.stop(["flaky"]).catch(() => {});
    }
  }, 10_000);

  test("a service that fails is promptly removed from persisted state", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 0.2;
    cfg.services.flaky = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "process.exit(1)"], shell: false },
      restart: { policy: "never", max_retries: 0, backoff_seconds: 0 },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.start({ services: ["flaky"] });

      await waitFor(() => sup.snapshot().services.flaky?.state === "FAILED");

      const persisted = readPersistedState(dir);
      expect(persisted?.processes.find((p) => p.name === "flaky")).toBeUndefined();
    } finally {
      await sup.stop(["flaky"]).catch(() => {});
    }
  }, 10_000);

  test("adopting an already-listening service via its fixed port preserves the persisted start time, not \"now\"", async () => {
    const dir = tmp();
    const port = await freePort();
    const svcCfg = {
      ...emptyService(),
      command: bunServe(port),
      ports: [{ name: "http", value: port, auto: false }],
    };
    const cfg1 = defaultConfig();
    cfg1.repoRoot = dir;
    cfg1.logs.persistence.enabled = false;
    cfg1.shutdown.grace_seconds = 0.2;
    cfg1.services.api = svcCfg;
    const cfg2 = defaultConfig();
    cfg2.repoRoot = dir;
    cfg2.logs.persistence.enabled = false;
    cfg2.shutdown.grace_seconds = 0.2;
    cfg2.services.api = svcCfg;
    const stub = { detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }) };
    const sup1 = new Supervisor(cfg1, stub);
    // A second supervisor instance stands in for a fresh daemon adopting a
    // service a previous one left running — claimIfAlreadyUp, not
    // recoverSession (which already preserved this correctly).
    const sup2 = new Supervisor(cfg2, stub);
    try {
      await sup1.start({ services: ["api"] });
      const originalStart = sup1.snapshot().services.api?.startTime;
      expect(originalStart).toBeTruthy();

      // Let real time move on so an adoption that (bug) stamps "now" instead
      // of the persisted start time is clearly distinguishable from one that
      // correctly preserves it.
      await sleep(1500);

      await sup2.start({ services: ["api"] });

      expect(sup2.snapshot().services.api?.startTime).toBe(originalStart);
    } finally {
      await sup2.stop(["api"]).catch(() => {});
      await sup1.stop(["api"]).catch(() => {});
    }
  }, 15_000);
});

describe("per-service launch context", () => {
  test("start() records each service's own profile and environment source", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 0.2;
    cfg.profiles.backend = { services: ["api"], environment: {} };
    cfg.services.api = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "setInterval(() => {}, 1000);"], shell: false },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.start({ services: ["api"], profile: "backend" });
      expect(sup.snapshot().services.api?.profile).toBe("backend");
      expect(sup.snapshot().services.api?.env_source).toBe("daemon");

      await sup.restart(["api"], { clientEnv: { X: "1" } });
      expect(sup.snapshot().services.api?.env_source).toBe("client");
    } finally {
      await sup.stop(["api"]).catch(() => {});
    }
  }, 10_000);

  test("a crash-restart resolves its environment from the service's own tracked profile, not whatever the daemon-wide fallback has since become", async () => {
    const dir = tmp();
    const markerFile = join(dir, "profile-marker.txt");
    const doneFile = join(dir, "crashed-once.marker");
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 0.2;
    cfg.profiles.backend = { services: ["flaky"], environment: { PROFILE_MARKER: "backend-marker" } };
    cfg.services.flaky = {
      ...emptyService(),
      environment: { vars: { OUT_FILE: markerFile, CRASH_MARKER: doneFile }, required: [], defaults: {} },
      command: {
        args: [
          process.execPath,
          "-e",
          "const fs=require('fs'); fs.writeFileSync(process.env.OUT_FILE, process.env.PROFILE_MARKER ?? 'unset'); if(!fs.existsSync(process.env.CRASH_MARKER)){fs.writeFileSync(process.env.CRASH_MARKER,'1'); process.exit(1);} setInterval(()=>{},1000);",
        ],
        shell: false,
      },
      restart: { policy: "always", max_retries: 5, backoff_seconds: 0.2 },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.start({ services: ["flaky"], profile: "backend" });
      await waitForFileContent(markerFile, "backend-marker");
      // Delete it so the check below can only pass on a fresh write from the
      // post-crash-restart process, never stale content from this first one.
      unlinkSync(markerFile);

      // Simulates an unrelated service elsewhere being started under a
      // different profile while flaky's crash-restart is still pending in
      // its backoff window — the daemon-wide fallback moves, but flaky's
      // own tracked context (recorded when it was started above) is what
      // its crash-restart must actually resolve its environment from.
      (sup as unknown as { profile: string }).profile = "frontend";
      (sup as unknown as { profileEnv: Record<string, string> }).profileEnv = { PROFILE_MARKER: "frontend-marker" };

      await waitFor(() => (sup.snapshot().services.flaky?.restarts ?? 0) > 0);
      await waitForFileContent(markerFile, "backend-marker");
    } finally {
      await sup.stop(["flaky"]).catch(() => {});
    }
  }, 15_000);
});

describe("lifecycle generations", () => {
  test("a slow health check for a superseded generation cannot corrupt the newer process's state", async () => {
    const dir = tmp();
    // A real plugin file, loaded the normal way (cfg.plugins), so the
    // "gate" health type already exists by the time run()'s
    // checkPluginHealthTypes() validates it — a plugin pushed onto the
    // registry after run() would be too late for that check. It reaches
    // back into the test via a well-known globalThis slot: the dynamically
    // imported module and this test file share the same process, so that's
    // the only channel available across that boundary.
    const gateState = { calls: 0, resolveFirst: undefined as ((res: { status: string; message: string }) => void) | undefined };
    (globalThis as Record<string, unknown>).__testHealthGate = gateState;
    const pluginPath = join(dir, "health-gate-plugin.ts");
    writeFileSync(
      pluginPath,
      `export const healthChecks = [{
  name: "gate",
  check: () => new Promise((resolve) => {
    const state = (globalThis as Record<string, { calls: number; resolveFirst?: (res: unknown) => void }>).__testHealthGate;
    state.calls += 1;
    if (state.calls === 1) {
      state.resolveFirst = resolve;
      return;
    }
    resolve({ status: "HEALTHY", message: "current" });
  }),
}];
`,
    );
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 1;
    cfg.plugins = [{ path: pluginPath }];
    cfg.services.api = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "setInterval(() => {}, 1000)"], shell: false },
      // interval_seconds is generous on purpose: within this test's window,
      // each generation's startHealth() should only ever see its own single
      // immediate tick, not a second one racing in from the same instance.
      health: { ...emptyHealth(), type: "gate", interval_seconds: 30, timeout_seconds: 30 },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.run();
      // Not awaited: start()'s wave loop awaits health before returning, and
      // generation 1's check is held open on purpose — awaiting it directly
      // would hang until the health-wait timeout. It resolves on its own
      // once generation 2 (below) makes the service healthy.
      void sup.start({ services: ["api"] }).catch(() => {});
      await waitFor(() => gateState.calls >= 1);

      // Generation 2: a real restart, spawning a new process under a new
      // generation while generation 1's check above is still pending.
      await sup.restart(["api"]);
      await waitFor(() => sup.snapshot().services.api?.health === "HEALTHY");

      // Generation 1's stale check finally resolves — unhealthy. Without the
      // generation guard in startHealth()'s tick(), this would flip the
      // service (now on generation 2, and genuinely healthy) to UNHEALTHY.
      gateState.resolveFirst?.({ status: "UNHEALTHY", message: "stale" });
      await sleep(50);
      expect(sup.snapshot().services.api?.health).toBe("HEALTHY");
    } finally {
      await sup.stop(["api"]).catch(() => {});
      await sup.shutdown(false);
      delete (globalThis as Record<string, unknown>).__testHealthGate;
    }
  }, 15_000);
});

describe("stop/restart graph direction", () => {
  test("stop cascades to dependents; plain restart touches only the named service; restart --cascade also restarts dependents", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 1;
    const longRunning = { args: [process.execPath, "-e", "setInterval(() => {}, 1000)"], shell: false };
    // auth <- api <- worker (api depends on auth, worker depends on api).
    cfg.services.auth = { ...emptyService(), command: longRunning };
    cfg.services.api = { ...emptyService(), command: longRunning, dependencies: ["auth"] };
    cfg.services.worker = { ...emptyService(), command: longRunning, dependencies: ["api"] };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.start({ services: ["worker"] });
      expect(Object.values(pidsOf(sup, ["auth", "api", "worker"])).every((pid) => pid > 0)).toBe(true);

      // Stopping the root dependency (auth) must cascade forward to
      // everything that depends on it — leaving api or worker running
      // against a dead auth would be worse than stopping them too.
      await sup.stop(["auth"]);
      const afterStop = sup.snapshot().services;
      expect(afterStop.auth?.state).toBe("STOPPED");
      expect(afterStop.api?.state).toBe("STOPPED");
      expect(afterStop.worker?.state).toBe("STOPPED");

      await sup.start({ services: ["worker"] });
      const running = pidsOf(sup, ["auth", "api", "worker"]);

      // A plain restart of api must touch only api: auth (api's own
      // dependency) and worker (api's dependent) keep their pids.
      await sup.restart(["api"]);
      const afterPlain = pidsOf(sup, ["auth", "api", "worker"]);
      expect(afterPlain.auth).toBe(running.auth);
      expect(afterPlain.api).not.toBe(running.api);
      expect(afterPlain.worker).toBe(running.worker);

      // restart --cascade also restarts api's dependent (worker), but still
      // never touches api's own dependency (auth).
      await sup.restart(["api"], { cascade: true });
      const afterCascade = pidsOf(sup, ["auth", "api", "worker"]);
      expect(afterCascade.auth).toBe(afterPlain.auth);
      expect(afterCascade.api).not.toBe(afterPlain.api);
      expect(afterCascade.worker).not.toBe(afterPlain.worker);
    } finally {
      await sup.stop([]).catch(() => {});
      await sup.shutdown(false);
    }
  }, 20_000);

  test("dispatch(\"restart\") reads cascade from the wire params", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 1;
    const longRunning = { args: [process.execPath, "-e", "setInterval(() => {}, 1000)"], shell: false };
    cfg.services.api = { ...emptyService(), command: longRunning };
    cfg.services.worker = { ...emptyService(), command: longRunning, dependencies: ["api"] };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.start({ services: ["worker"] });
      const before = pidsOf(sup, ["api", "worker"]);
      await sup.dispatch("restart", { services: ["api"], cascade: true });
      const after = pidsOf(sup, ["api", "worker"]);
      expect(after.api).not.toBe(before.api);
      expect(after.worker).not.toBe(before.worker);
    } finally {
      await sup.stop([]).catch(() => {});
      await sup.shutdown(false);
    }
  }, 15_000);
});

describe("port-assignment error attribution", () => {
  test("a port conflict fails the service actually involved, never an unrelated pending one", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    const longRunning = { args: [process.execPath, "-e", "setInterval(() => {}, 1000)"], shell: false };
    cfg.services.a = { ...emptyService(), command: longRunning };
    // b and c collide on the same fixed port; a has none and is wholly
    // unrelated to that conflict, but is first in iteration/pending order.
    cfg.services.b = { ...emptyService(), command: longRunning, ports: [{ name: "http", value: 19_998, auto: false }] };
    cfg.services.c = { ...emptyService(), command: longRunning, ports: [{ name: "http", value: 19_998, auto: false }] };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await expect(sup.start({ services: ["a", "b", "c"] })).rejects.toThrow(/duplicate port/);
      const snap = sup.snapshot().services;
      expect(snap.a?.state).not.toBe("FAILED");
      const blamed = ["b", "c"].filter((name) => snap[name]?.state === "FAILED");
      expect(blamed).toEqual(["c"]);
    } finally {
      await sup.stop([]).catch(() => {});
      await sup.shutdown(false);
    }
  }, 15_000);
});

function pidsOf(sup: Supervisor, names: string[]): Record<string, number> {
  const snap = sup.snapshot().services;
  const out: Record<string, number> = {};
  for (const name of names) {
    out[name] = snap[name]?.pid ?? 0;
  }
  return out;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error("timed out waiting for condition");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFileContent(path: string, expected: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      last = readFileSync(path, "utf8");
      if (last === expected) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${path} to contain ${JSON.stringify(expected)}; last saw ${JSON.stringify(last)}`);
}

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
