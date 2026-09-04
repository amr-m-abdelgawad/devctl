import { createServer as createHttpServer } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyHealth, emptyService } from "./config/types.ts";
import { ConfigurationReloadFailed, SessionRecovered } from "./events.ts";
import { MCP_TOOLS } from "./mcp/tools.ts";
import { available } from "./ports.ts";
import { processAlive, readPersistedState, socketPath, writePersistedState } from "./storage.ts";
import { Supervisor, diffReload } from "./supervisor.ts";
import { saveTuiPreferences } from "./tui/tui-config.ts";
import { TokenManager, type AccessToken, type TokenProvider } from "./token.ts";

function tmp(): string {
  const dir = join(process.env.TMPDIR ?? "/tmp", `devctl-sup-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  process.env.DEVCTL_HOME = dir;
  return dir;
}

function token(partial: Partial<AccessToken> = {}): AccessToken {
  return {
    accessToken: "tok",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 60_000),
    audience: "",
    identity: "sa:worker-dev@example.com",
    scopes: [],
    ...partial,
  };
}

describe("supervisor snapshot", () => {
  test("health start period ignores early failures before applying the configured threshold", async () => {
    const cfg = defaultConfig();
    cfg.repoRoot = tmp();
    cfg.logs.persistence.enabled = false;
    cfg.services.api = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "setInterval(()=>{}, 1000)"], shell: false },
      health: { ...emptyHealth(), type: "command", command: { args: [process.execPath, "-e", "process.exit(1)"], shell: false }, interval_seconds: 0.02, start_period_seconds: 0.15, unhealthy_threshold: 1 },
      restart: { policy: "on_failure", max_retries: 2, backoff_seconds: 1 },
    };
    const sup = new Supervisor(cfg, { detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }) });
    try {
      await sup.start({ services: ["api"] });
      await sleep(100);
      expect(sup.snapshot().services.api?.health).toBe("UNKNOWN");
      expect(sup.snapshot().services.api?.restarts).toBe(0);
      await sleep(160);
      expect(sup.snapshot().services.api?.restarts).toBe(1);
    } finally {
      await sup.stop(["api"]);
    }
  });

  test("service_healthy dependency conditions delay the dependent launch", async () => {
    const dir = tmp();
    const ready = join(dir, "ready");
    const launched = join(dir, "launched");
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.services.db = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(ready)}, '1'), 120); setInterval(()=>{}, 1000)`], shell: false },
      health: { ...emptyHealth(), type: "command", command: { args: [process.execPath, "-e", `process.exit(require('fs').existsSync(${JSON.stringify(ready)}) ? 0 : 1)`], shell: false }, interval_seconds: 0.02 },
    };
    cfg.services.api = { ...emptyService(), dependencies: [{ service: "db", condition: "service_healthy" }], command: { args: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(launched)}, '1'); setInterval(()=>{}, 1000)`], shell: false } };
    const sup = new Supervisor(cfg, { detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }) });
    try {
      const started = Date.now();
      await sup.start({ services: ["api"] });
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
      await sleep(30);
      expect(existsSync(launched)).toBe(true);
    } finally {
      await sup.stop([]);
    }
  });
  test("runs hooks around an explicit service start and runs configured tasks", async () => {
    const dir = tmp();
    const marker = join(dir, "order.txt");
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.services.api = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(marker)}, 'service\\n'); setInterval(()=>{}, 1000)`], shell: false },
      hooks: {
        pre_start: { args: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(marker)}, 'pre\\n')`], shell: false },
        post_start: { args: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(marker)}, 'post\\n')`], shell: false },
      },
    };
    cfg.tasks.check = { command: { args: [process.execPath, "-e", "console.log(process.env.TASK_VALUE)"], shell: false }, shell: false, working_dir: "", dependencies: [], environment: { vars: { TASK_VALUE: "ready" }, required: [], defaults: {} } };
    const sup = new Supervisor(cfg, { detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }) });
    try {
      await sup.start({ services: ["api"] });
      const result = await sup.runTask("check", {});
      const order = readFileSync(marker, "utf8").trim().split("\n");
      expect(order[0]).toBe("pre");
      expect(order).toContain("service");
      expect(order).toContain("post");
      expect(result.stdout).toBe("ready\n");
    } finally {
      await sup.stop(["api"]);
    }
  });

  test("exec uses a stopped service's resolved environment and working directory", async () => {
    const dir = tmp();
    const workDir = join(dir, "api");
    mkdirSync(workDir, { recursive: true });
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.services.api = { ...emptyService(), working_dir: "api", command: { args: ["unused"], shell: false }, environment: { vars: { EXEC_MARKER: "resolved" }, required: [], defaults: {} } };
    const sup = new Supervisor(cfg, { detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }) });
    const result = await sup.execService("api", [process.execPath, "-e", "console.log(process.cwd()); console.log(process.env.EXEC_MARKER)"], {});
    expect(result.stdout.endsWith("/api\nresolved\n")).toBe(true);
    expect(sup.snapshot().services.api?.state).toBe("STOPPED");
    const printed = await sup.execService("api", [], { CLIENT_ONLY: "yes" }, true);
    expect(printed.environment?.CLIENT_ONLY).toBe("yes");
  });

  test("a failed pre-start hook prevents the service process from launching", async () => {
    const dir = tmp();
    const marker = join(dir, "launched.txt");
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.services.api = { ...emptyService(), command: { args: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`], shell: false }, hooks: { pre_start: { args: [process.execPath, "-e", "process.exit(7)"], shell: false }, post_start: { args: [], shell: false } } };
    const sup = new Supervisor(cfg, { detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }) });
    await expect(sup.start({ services: ["api"] })).rejects.toThrow(/failed to start/);
    expect(existsSync(marker)).toBe(false);
    expect(sup.snapshot().services.api?.state).toBe("FAILED");
  });
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
    // An automatic (no-args) refresh only updates ADC/user/project — it must
    // not probe service accounts on its own.
    await sup.refreshIdentity();
    const before = sup.snapshot().identity;
    expect(before.user).toBe("dev@example.com");
    expect(before.adc).toBe(true);
    expect(before.service_account_status["worker-dev@example.com"]).toBe("unknown");
    expect(before.service_accounts["worker-dev@example.com"]).toBeUndefined();

    await sup.refreshIdentity({ probeServiceAccounts: true });
    const ident = sup.snapshot().identity;
    expect(ident.service_account_status["worker-dev@example.com"]).toBe("available");
    expect(ident.service_accounts["worker-dev@example.com"]).toBe(true);
    try {
      await sup.start({ services: ["ping"], detach: true });
      expect(sup.snapshot().detached).toBe(true);
      expect(sup.isDetached()).toBe(true);
    } finally {
      await sup.stop(["ping"]);
    }
  }, 15_000);

  test("a token refresh outside refreshIdentity() still updates the credentials snapshot", async () => {
    // Regression: a proxied request (or the token endpoint) refreshes a
    // token via TokenManager.get() directly, entirely outside the
    // boot/reload/auth_refresh schedule that refreshIdentity() runs on. The
    // supervisor's TokenRefreshed subscriber must pick that up so the
    // Credentials/Auth screens don't keep showing a pre-refresh snapshot.
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.google.project_id = "company-dev";
    const provider: TokenProvider = {
      name: "stub",
      fetch: async (identity) => {
        if (!identity.startsWith("sa:")) {
          throw new Error("not sa");
        }
        return token();
      },
    };
    // deps.tokens is constructed before the Supervisor (and its own Bus)
    // exists, so a TokenManager passed in that way can never carry the
    // supervisor's real bus reference — it would publish TokenRefreshed
    // nowhere. Let the supervisor build its own default TokenManager (wired
    // to its own bus, exactly like production) and swap in the stub
    // provider afterward via the same replaceProviders() plugins use.
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({
        gcloudInstalled: true,
        adcAvailable: true,
        userEmail: "dev@example.com",
        projectID: "company-dev",
        projectSource: "configuration",
      }),
    });
    await sup.refreshIdentity();
    expect(sup.snapshot().credentials?.entries).toEqual([]);

    const tokens = (sup as unknown as { tokens: TokenManager }).tokens;
    tokens.replaceProviders([provider]);
    await tokens.get("sa:worker-dev@example.com", "", []);

    await waitFor(() => (sup.snapshot().credentials?.entries.length ?? 0) > 0);
    const entries = sup.snapshot().credentials?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.identity).toBe("sa:worker-dev@example.com");
    expect(entries[0]?.valid).toBe(true);
  });

  test("auth_refresh (pressing r on the Auth screen) does not wipe credentials it never touches", async () => {
    // Regression: the auth_refresh RPC used to call tokens.invalidate() with
    // no key first — that deletes every credential in the store, not just
    // the ones this refresh is about to re-probe. probeServiceAccount() only
    // ever mints the plain (audience-less) impersonation check, so anything
    // else cached — the user token, or a route's IAP-audience-specific
    // credential — got wiped and never re-minted, and the Credentials screen
    // went from several entries down to just the one thing auth_refresh
    // happened to touch.
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.google.project_id = "company-dev";
    cfg.services.worker = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "setInterval(() => {}, 1e6)"], shell: false },
      identity: { type: "service_account", mode: "", service_account: "worker-dev@example.com" },
    };
    let calls = 0;
    const provider: TokenProvider = {
      name: "stub",
      fetch: async (identity, audience) => {
        calls += 1;
        return token({ accessToken: `tok-${calls}`, identity, audience });
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
    });
    const tokens = (sup as unknown as { tokens: TokenManager }).tokens;
    tokens.replaceProviders([provider]);

    // Pre-populate two credentials that auth_refresh never re-mints: the
    // user token, and this service account's IAP-audience-specific one (as
    // opposed to the plain, audience-less impersonation check auth_refresh
    // actually performs).
    await tokens.get("user", "", []);
    await tokens.get("sa:worker-dev@example.com", "https://worker.local", []);
    await sup.refreshIdentity();
    expect(sup.snapshot().credentials?.entries).toHaveLength(2);

    await sup.dispatch("auth_refresh", null);

    const entries = sup.snapshot().credentials?.entries ?? [];
    const keys = entries.map((e) => `${e.identity}|${e.audience}`).sort();
    expect(keys).toEqual(["sa:worker-dev@example.com|", "sa:worker-dev@example.com|https://worker.local", "user|"]);
  });

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
      // Windows named pipes vanish with their owning process — existsSync/
      // unlinkSync don't apply there, so removeStaleSocket() returns before
      // ever calling these mocks on win32 (see supervisor.ts).
      const expectedCleanup = process.platform === "win32" ? [] : ["check", "unlink", "check", "unlink"];
      expect(events.slice(1)).toEqual(expectedCleanup);
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

  test("a request through the live proxy shows up in the status snapshot without any explicit refresh", async () => {
    // Not just stats() in isolation: this exercises the full path a TUI
    // client actually rides — request hits the real ProxyServer, the daemon
    // is asked for a snapshot exactly as the TUI would ask, and it must
    // reflect the new request without an "r"-equivalent action in between.
    const upstream = createHttpServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upAddr = upstream.address();
    const upPort = typeof upAddr === "object" && upAddr ? upAddr.port : 0;

    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.proxy.enabled = true;
    cfg.proxy.listen = { host: "127.0.0.1", port: await freePort() };
    cfg.proxy.routes.push({
      name: "stub",
      match: { host: "", path: "" },
      upstream: { url: `http://127.0.0.1:${upPort}` },
      auth: { type: "none", identity: { type: "user", service_account: "" }, audience: "", service_account: "" },
    });
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.run();
      // Proxy startup is lazy (see the "lazy, sticky proxy" test above) — an
      // explicit proxy_start is the same action the TUI's "n" key sends.
      await sup.dispatch("proxy_start", null);
      expect(sup.snapshot().proxy.running).toBe(true);
      expect(sup.snapshot().proxy.recentRequests).toEqual([]);

      const proxyAddr = sup.snapshot().proxy.address ?? "";
      const resp = await fetch(`http://${proxyAddr}/hello`);
      expect(resp.status).toBe(200);
      const echoedId = resp.headers.get("x-devctl-request-id") ?? "";
      expect(echoedId).not.toBe("");

      const snap = sup.snapshot();
      expect(snap.proxy.requestTotal).toBe(1);
      expect(snap.proxy.requestErrors).toBe(0);
      expect(snap.proxy.recentRequests).toHaveLength(1);
      expect(snap.proxy.recentRequests?.[0]?.path).toBe("/hello");
      expect(snap.proxy.recentRequests?.[0]?.route).toBe("stub");
      expect(snap.proxy.recentRequests?.[0]?.status).toBe(200);
      expect(snap.proxy.recentRequests?.[0]?.requestId).toBe(echoedId);
    } finally {
      await sup.shutdown(false);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

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

  test("mcp_start with no explicit port falls back to the saved preference, not straight to the derived default", async () => {
    const dir = tmp();
    const port = await freePort();
    // mcp_enabled left unset, so MCP does not auto-start at boot (already
    // covered above) — this is specifically about a client asking for MCP
    // on demand, like `devctl mcp --on` with no --port, or the RPC the TUI's
    // own toggle sends when its local state was never overridden.
    saveTuiPreferences({ mcp_port: port });
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.run();
      expect(sup.snapshot().mcp?.running).toBe(false);
      await sup.dispatch("mcp_start", null);
      const snap = sup.snapshot();
      expect(snap.mcp?.running).toBe(true);
      expect(snap.mcp?.port).toBe(port);
    } finally {
      await sup.shutdown(false);
    }
  }, 15_000);

  test("logs_clear is no longer a valid RPC method — a client cannot wipe the daemon's shared log buffer", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.run();
      // "clear logs" in the TUI must only affect that client's own view
      // (hiding old events locally via a since-timestamp), never wipe what
      // other attached clients — another TUI session, the CLI, MCP — still
      // see. run() itself already logs a startup line, so there's something
      // real to prove survives.
      const before = (await sup.dispatch("logs", {})) as { events: unknown[] };
      expect(before.events.length).toBeGreaterThan(0);
      await expect(sup.dispatch("logs_clear", null)).rejects.toThrow(/unknown method/);
      const after = (await sup.dispatch("logs", {})) as { events: unknown[] };
      expect(after.events.length).toBe(before.events.length);
    } finally {
      await sup.shutdown(false);
    }
  }, 15_000);

  test("logs_page RPC returns a bounded, cursor-carrying page instead of the whole buffer", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.run();
      const page = (await sup.dispatch("logs_page", { limit: 1 })) as {
        events: unknown[];
        nextCursor: string;
        prevCursor: string;
        hasNext: boolean;
        hasPrev: boolean;
        sessionChanged: boolean;
      };
      expect(page.events.length).toBe(1);
      expect(typeof page.nextCursor).toBe("string");
      expect(typeof page.prevCursor).toBe("string");
      expect(page.hasNext).toBe(false);
      expect(page.sessionChanged).toBe(false);
      // Still reachable through the plain, unbounded "logs" method too — the
      // old path isn't replaced yet, just joined by the new one.
      const unbounded = (await sup.dispatch("logs", {})) as { events: unknown[] };
      expect(unbounded.events.length).toBeGreaterThanOrEqual(page.events.length);
    } finally {
      await sup.shutdown(false);
    }
  }, 15_000);

  test("logs_stats RPC returns facet counts without an event payload", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.run();
      const facets = (await sup.dispatch("logs_stats", {})) as {
        total: number;
        byService: Record<string, number>;
        byLevel: Record<string, number>;
        bySource: Record<string, number>;
      };
      expect(facets.total).toBeGreaterThan(0);
      expect(facets.byService.devctl).toBeGreaterThan(0);
      expect("events" in facets).toBe(false);
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
        healthy_reset_threshold: 2,
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

describe("adopted service health environments", () => {
  test("recoverSession gives an adopted process's command health check a usable environment, not an empty one", async () => {
    const dir = tmp();
    const outFile = join(dir, "health-env.txt");
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 1;
    cfg.services.api = {
      ...emptyService(),
      command: { args: ["python", "main.py"], shell: false },
      health: {
        ...emptyHealth(),
        type: "command",
        command: {
          args: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(outFile)}, process.env.PATH ?? '');`],
          shell: false,
        },
        interval_seconds: 0.05,
        timeout_seconds: 2,
      },
    };
    const leftover = { pid: 4242, command: "python main.py", cwd: "" };
    writePersistedState(dir, {
      session_id: "2026-08-30T00-00-00Z-abc123",
      repo_root: dir,
      profile: "backend",
      processes: [{ name: "api", pid: leftover.pid, command: ["python", "main.py"], cwd: leftover.cwd, startTime: "", ports: {} }],
    });
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
      processAlive: (pid) => pid === leftover.pid,
      inspectProcess: async (pid) => (pid === leftover.pid ? leftover : undefined),
    });
    try {
      await (sup as unknown as { recoverSession: () => Promise<void> }).recoverSession();

      await waitFor(() => existsSync(outFile) && readFileSync(outFile, "utf8").length > 0);
      expect(readFileSync(outFile, "utf8").length).toBeGreaterThan(0);
    } finally {
      await sup.stop(["api"]).catch(() => {});
    }
  }, 10_000);

  test("claimIfAlreadyUp gives a claimed process's command health check a usable environment, not an empty one", async () => {
    const dir = tmp();
    const port = await freePort();
    const outFile = join(dir, "health-env.txt");
    const commandSpec = bunServe(port);
    const portsSpec = [{ name: "http", value: port, auto: false }];
    const cfg1 = defaultConfig();
    cfg1.repoRoot = dir;
    cfg1.logs.persistence.enabled = false;
    cfg1.shutdown.grace_seconds = 0.2;
    // sup1 has no health check of its own — the only thing that can write
    // outFile is whatever health check sup2 starts for the process it
    // claims, isolating the assertion to sup2's adoption path specifically.
    cfg1.services.api = { ...emptyService(), command: commandSpec, ports: portsSpec };
    const cfg2 = defaultConfig();
    cfg2.repoRoot = dir;
    cfg2.logs.persistence.enabled = false;
    cfg2.shutdown.grace_seconds = 0.2;
    cfg2.services.api = {
      ...emptyService(),
      command: commandSpec,
      ports: portsSpec,
      health: {
        ...emptyHealth(),
        type: "command",
        command: {
          args: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(outFile)}, process.env.PATH ?? '');`],
          shell: false,
        },
        interval_seconds: 0.05,
        timeout_seconds: 2,
      },
    };
    const stub = { detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }) };
    const sup1 = new Supervisor(cfg1, stub);
    const sup2 = new Supervisor(cfg2, stub);
    try {
      await sup1.start({ services: ["api"] });
      // sup1.start() only waits for the child to spawn, not for its async
      // Bun.serve() to actually bind — give it a moment so sup2 reliably
      // observes the port as occupied instead of racing to bind it too.
      await waitFor(async () => !(await available(port)), 3000);

      await sup2.start({ services: ["api"] });

      await waitFor(() => existsSync(outFile) && readFileSync(outFile, "utf8").length > 0);
      expect(readFileSync(outFile, "utf8").length).toBeGreaterThan(0);
    } finally {
      await sup2.stop(["api"]).catch(() => {});
      await sup1.stop(["api"]).catch(() => {});
    }
  }, 15_000);
});

describe("reload reconciliation", () => {
  function writeConfig(configPath: string, yaml: string): void {
    writeFileSync(configPath, yaml);
  }

  test("a service added by reload appears immediately, stopped", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    const configPath = join(dir, ".devctl", "config.yaml");
    writeConfig(
      configPath,
      `version: 1
project:
  name: reload-test
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
    try {
      expect(sup.snapshot().services.worker).toBeUndefined();

      writeConfig(
        configPath,
        `version: 1
project:
  name: reload-test
services:
  api:
    command: [echo, ok]
  worker:
    command: [echo, ok]
`,
      );
      await sup.reload();

      expect(sup.snapshot().services.worker?.state).toBe("STOPPED");
    } finally {
      await sup.stop([]).catch(() => {});
    }
  });

  test("reload forgets an already-stopped service once it's removed from configuration", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    const configPath = join(dir, ".devctl", "config.yaml");
    writeConfig(
      configPath,
      `version: 1
project:
  name: reload-test
services:
  api:
    command: [echo, ok]
  worker:
    command:
      - ${JSON.stringify(process.execPath)}
      - -e
      - "setInterval(() => {}, 1000)"
`,
    );
    const { load } = await import("./config/index.ts");
    const cfg = load(dir, "");
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 0.2;
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.start({ services: ["worker"] });
      await sup.stop(["worker"]);
      expect(sup.snapshot().services.worker?.state).toBe("STOPPED");

      writeConfig(
        configPath,
        `version: 1
project:
  name: reload-test
services:
  api:
    command: [echo, ok]
`,
      );
      await sup.reload();

      expect(sup.snapshot().services.worker).toBeUndefined();
    } finally {
      await sup.stop([]).catch(() => {});
    }
  }, 10_000);

  test("reload orphans a running service removed from configuration, and stop() can still reach it", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    const configPath = join(dir, ".devctl", "config.yaml");
    writeConfig(
      configPath,
      `version: 1
project:
  name: reload-test
services:
  api:
    command: [echo, ok]
  flaky:
    command:
      - ${JSON.stringify(process.execPath)}
      - -e
      - "setInterval(() => {}, 1000)"
`,
    );
    const { load } = await import("./config/index.ts");
    const cfg = load(dir, "");
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 0.2;
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.start({ services: ["flaky"] });
      const pidBefore = sup.snapshot().services.flaky?.pid ?? 0;
      expect(pidBefore).toBeGreaterThan(0);

      writeConfig(
        configPath,
        `version: 1
project:
  name: reload-test
services:
  api:
    command: [echo, ok]
`,
      );
      await sup.reload();

      // Still tracked and still running — just orphaned, not silently
      // dropped with no way to stop it short of a full `down`.
      expect(sup.snapshot().services.flaky?.orphaned).toBe(true);
      expect(sup.snapshot().services.flaky?.pid).toBe(pidBefore);

      // No config entry left for it, but stop() must still reach it by
      // name instead of throwing "unknown service".
      await sup.stop(["flaky"]);

      expect(sup.snapshot().services.flaky).toBeUndefined();
      expect(processAlive(pidBefore)).toBe(false);
    } finally {
      await sup.stop([]).catch(() => {});
    }
  }, 10_000);

  test("reload rejects a candidate config with an unresolvable plugin health type, keeping the previous config", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    const configPath = join(dir, ".devctl", "config.yaml");
    writeConfig(
      configPath,
      `version: 1
project:
  name: reload-test
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
    try {
      // plugins non-empty lets an unrecognized health.type through config
      // validation (plugins load after parsing) — but this supervisor never
      // loaded one, so its registry has no "custom_unknown_type" check.
      writeConfig(
        configPath,
        `version: 1
project:
  name: reload-test
plugins:
  - path: ./devctl-plugin.ts
services:
  api:
    command: [echo, ok]
  worker:
    command: [echo, ok]
    health:
      type: custom_unknown_type
`,
      );

      await expect(sup.reload()).rejects.toThrow(/unknown health check type/);

      const failure = seen.find((ev) => ev.type === ConfigurationReloadFailed);
      expect(failure).toBeDefined();
      expect(sup.snapshot().services.worker).toBeUndefined();
      const snap = (await sup.dispatch("config_snapshot", null)) as { services: Record<string, unknown> };
      expect(snap.services.worker).toBeUndefined();
    } finally {
      await sup.stop([]).catch(() => {});
    }
  });
});

describe("service-account status", () => {
  test("starting a service under a service-account identity updates its status immediately, with no explicit refresh", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 0.2;
    cfg.services.goodworker = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "setInterval(() => {}, 1000)"], shell: false },
      identity: { type: "service_account", mode: "", service_account: "good@example.com" },
    };
    cfg.services.badworker = {
      ...emptyService(),
      command: { args: [process.execPath, "-e", "setInterval(() => {}, 1000)"], shell: false },
      identity: { type: "service_account", mode: "", service_account: "bad@example.com" },
    };
    const provider: TokenProvider = {
      name: "stub",
      fetch: async (identity) => {
        if (identity === "sa:bad@example.com") {
          throw new Error("permission denied");
        }
        if (!identity.startsWith("sa:")) {
          throw new Error("not sa");
        }
        return token();
      },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: true, adcAvailable: true, userEmail: "dev@example.com", projectID: "", projectSource: "" }),
      tokens: new TokenManager(60_000, [provider]),
    });
    try {
      expect(sup.snapshot().identity.service_account_status["good@example.com"]).toBe("unknown");
      expect(sup.snapshot().identity.service_account_status["bad@example.com"]).toBe("unknown");

      await sup.start({ services: ["goodworker"] });
      expect(sup.snapshot().identity.service_account_status["good@example.com"]).toBe("available");
      expect(sup.snapshot().identity.service_accounts["good@example.com"]).toBe(true);

      await sup.start({ services: ["badworker"] }).catch(() => {});
      expect(sup.snapshot().identity.service_account_status["bad@example.com"]).toBe("unavailable");
      expect(sup.snapshot().identity.service_accounts["bad@example.com"]).toBe(false);
    } finally {
      await sup.stop([]).catch(() => {});
    }
  }, 10_000);

  test("an automatic refresh after reload does not probe service accounts", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    const configPath = join(dir, ".devctl", "config.yaml");
    writeFileSync(
      configPath,
      `version: 1
project:
  name: sa-test
services:
  worker:
    command: [echo, ok]
    identity:
      type: service_account
      service_account: worker-dev@example.com
`,
    );
    const { load } = await import("./config/index.ts");
    const cfg = load(dir, "");
    cfg.logs.persistence.enabled = false;
    let probed = false;
    const provider: TokenProvider = {
      name: "stub",
      fetch: async (identity) => {
        if (identity.startsWith("sa:")) {
          probed = true;
          return token();
        }
        throw new Error("not sa");
      },
    };
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: true, adcAvailable: true, userEmail: "dev@example.com", projectID: "", projectSource: "" }),
      tokens: new TokenManager(60_000, [provider]),
    });
    try {
      await sup.reload();
      // refreshIdentity() runs fire-and-forget from reload() — give it a
      // moment to actually run before checking it didn't probe anything.
      await sleep(300);

      expect(probed).toBe(false);
      expect(sup.snapshot().identity.service_account_status["worker-dev@example.com"]).toBe("unknown");
    } finally {
      await sup.stop([]).catch(() => {});
    }
  });

  test("the auth_refresh RPC explicitly probes service accounts", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.services.worker = {
      ...emptyService(),
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
      detectGoogle: async () => ({ gcloudInstalled: true, adcAvailable: true, userEmail: "dev@example.com", projectID: "", projectSource: "" }),
      tokens: new TokenManager(60_000, [provider]),
    });
    try {
      expect(sup.snapshot().identity.service_account_status["worker-dev@example.com"]).toBe("unknown");

      await sup.dispatch("auth_refresh", null);

      expect(sup.snapshot().identity.service_account_status["worker-dev@example.com"]).toBe("available");
    } finally {
      await sup.stop([]).catch(() => {});
    }
  });

  test("doctor inspection probes service accounts through asMcpHost", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.services.worker = {
      ...emptyService(),
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
      detectGoogle: async () => ({ gcloudInstalled: true, adcAvailable: true, userEmail: "dev@example.com", projectID: "", projectSource: "" }),
      tokens: new TokenManager(60_000, [provider]),
    });
    try {
      expect(sup.snapshot().identity.service_account_status["worker-dev@example.com"]).toBe("unknown");

      await (sup as unknown as { asMcpHost: () => { doctor: () => Promise<unknown> } }).asMcpHost().doctor();

      expect(sup.snapshot().identity.service_account_status["worker-dev@example.com"]).toBe("available");
    } finally {
      await sup.stop([]).catch(() => {});
    }
  });
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

describe("supervisor socket error handling", () => {
  test("an error on an accepted client socket is handled, not thrown", async () => {
    const dir = tmp();
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    cfg.shutdown.grace_seconds = 1;
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    let client: Socket | undefined;
    try {
      await sup.run();
      const server = (sup as unknown as { server?: Server }).server;
      expect(server).toBeDefined();

      // The server's own "connection" listener fires with the identical
      // Socket instance handleConn() wraps — capture it to poke the same
      // object devctl's own error listener (or its absence) would see.
      let captured: Socket | undefined;
      server?.on("connection", (s) => {
        captured = s;
      });

      client = connect(socketPath(dir));
      await new Promise<void>((resolve, reject) => {
        client?.once("connect", () => resolve());
        client?.once("error", reject);
      });
      await waitFor(() => captured !== undefined);

      // EventEmitter's special-cased "error" handling throws synchronously
      // from emit() itself when nothing is listening — exactly the failure
      // mode an ECONNRESET from an abruptly disconnected client would hit
      // without a listener. Not throwing here is the same thing as the
      // daemon surviving a real disconnect.
      expect(() => captured?.emit("error", new Error("ECONNRESET (simulated)"))).not.toThrow();
    } finally {
      client?.destroy();
      await sup.shutdown(false);
    }
  }, 10_000);
});

function pidsOf(sup: Supervisor, names: string[]): Record<string, number> {
  const snap = sup.snapshot().services;
  const out: Record<string, number> = {};
  for (const name of names) {
    out[name] = snap[name]?.pid ?? 0;
  }
  return out;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
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
    args: [process.execPath, "-e", `Bun.serve({hostname:"127.0.0.1",port:${port},fetch(){return new Response("ok")}})`],
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
