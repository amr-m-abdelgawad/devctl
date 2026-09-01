import { createServer, type Server } from "node:net";
import { existsSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { cpus, loadavg, platform, uptime } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  type DevctlConfig,
  type ServiceConfig,
  captureStderr,
  captureStdout,
  graceSeconds,
  listenAddress,
  load,
  stopOnExit,
  unresolvedHealthTypes,
  unresolvedIdentityTypes,
} from "./config/index.ts";
import { envList, resolveEnvironment, runtimeForService, secretManagerFetcher } from "./environment.ts";
import { DevctlError, KindConfiguration, KindGeneral, KindHealthCheck, KindProcessStart, humanMessage, newError, serializeError } from "./errors.ts";
import {
  AuthenticationChanged,
  Bus,
  ConfigurationChanged,
  ServiceFailed,
  ServiceHealthChanged,
  ServiceStarted,
  ServiceStateChanged,
  ServiceStopped,
  SessionRecovered,
  TokenRefreshed,
  TokenRefreshFailed,
  newEvent,
} from "./events.ts";
import { detectGoogle, detectIdentity, type GoogleStatus } from "./google.ts";
import { checkHealth, healthIntervalMs, healthLevel } from "./health.ts";
import { readHostMemory } from "./host-stats.ts";
import { configuredServiceAccounts, fromConfig, identityBlockers, requiresCloud, resolveIdentity, tokenIdentityKey } from "./identity.ts";
import { LogManager, type LogEvent } from "./logs.ts";
import { assignPorts, findPortHolder, freePort, occupiedFixedPorts } from "./ports.ts";
import { loadPluginPaths, type Registry } from "./plugins.ts";
import { ProcessManager, handleStillRunning, inspectProcess, processAlive, sameProcess, sampleResourceUsage, type ProcessIdentity } from "./processes.ts";
import { McpHttpServer } from "./mcp/server.ts";
import { type McpHost } from "./mcp/tools.ts";
import { resolveMcpPort } from "./mcp/port.ts";
import { runDoctor } from "./doctor.ts";
import { ProxyServer, TokenEndpoint } from "./proxy.ts";
import { Detector } from "./secrets.ts";
import {
  HealthHealthy,
  HealthUnhealthy,
  HealthUnknown,
  StateFailed,
  StateHealthy,
  StateUnhealthy,
  StateRestarting,
  StateRunning,
  StateStarting,
  StateStopped,
  StateStopping,
  displayState,
  emptyRuntime,
  formatPlan,
  resolveStartRequest,
  shutdownPlan,
  startupPlan,
  type Plan,
  type Runtime,
  type ServiceHealth,
  type ServiceState,
} from "./services.ts";
import { acquireLock, newSessionID, randomSecret, readOrCreateMcpToken, readPersistedState, socketPath, writePersistedState } from "./storage.ts";
import { TokenManager, googleTokenProviders } from "./token.ts";
import type { Envelope, IdentitySnapshot, LogsRequest, ReloadResult, StartRequest, StatusSnapshot, SystemSnapshot } from "./types.ts";

const IDENTITY_PROBE_MS = 4_000;
const HEALTH_POLL_MS = 100;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_SECONDS = 2;
const DEFAULT_HEALTH_INTERVAL_MS = 2000;
const WATCH_DEBOUNCE_MS = 200;
const HEALTH_RESTART_STREAK = 3;
const RESOURCE_POLL_MS = 3_000;

export class Supervisor {
  private readonly cfg: DevctlConfig;
  private readonly sessionID: string;
  private readonly internalTok: string;
  private readonly bus: Bus;
  private readonly logs: LogManager;
  private readonly procs: ProcessManager;
  private readonly tokens: TokenManager;
  private readonly detector: Detector;
  private proxy?: ProxyServer;
  private mcp?: McpHttpServer;
  private readonly mcpToken: string;
  private tokenEP?: TokenEndpoint;
  private profile = "";
  private readonly runtimes = new Map<string, Runtime>();
  private readonly ports = new Map<string, Record<string, number>>();
  private readonly healthTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly restarts = new Map<string, number>();
  private lock?: { release: () => void };
  private server?: Server;
  private shuttingDown = false;
  private detached = false;
  private identityCache: IdentitySnapshot = emptyIdentitySnapshot();
  private readonly detectGoogleFn: (project: string) => Promise<GoogleStatus>;
  private readonly inspectProcessFn: (pid: number) => Promise<ProcessIdentity | undefined>;
  private readonly processAliveFn: (pid: number) => boolean;
  private registry?: Registry;
  private restartRequired: string[] = [];
  private readonly processMeta = new Map<string, { command: string[]; cwd: string; startTime: Date }>();
  private credentialEntries: Array<{ identity: string; audience: string; expires_at: string; valid: boolean }> = [];
  private boundTokenURL = "";
  private configWatcher?: FSWatcher;
  private watchTimer?: ReturnType<typeof setTimeout>;
  private readonly unhealthyStreak = new Map<string, number>();
  private profileEnv: Record<string, string> = {};
  private resourceTimer?: ReturnType<typeof setInterval>;

  constructor(
    cfg: DevctlConfig,
    deps?: {
      detectGoogle?: (project: string) => Promise<GoogleStatus>;
      tokens?: TokenManager;
      inspectProcess?: (pid: number) => Promise<ProcessIdentity | undefined>;
      processAlive?: (pid: number) => boolean;
    },
  ) {
    this.cfg = cfg;
    this.sessionID = newSessionID();
    this.internalTok = randomSecret();
    this.mcpToken = readOrCreateMcpToken(cfg.repoRoot);
    this.bus = new Bus(2048);
    this.detectGoogleFn = deps?.detectGoogle ?? detectGoogle;
    this.inspectProcessFn = deps?.inspectProcess ?? inspectProcess;
    this.processAliveFn = deps?.processAlive ?? processAlive;
    this.detector = new Detector(cfg.secrets.extra_markers, cfg.secrets.extra_patterns);
    this.logs = new LogManager(
      cfg.logs.max_memory_events,
      this.bus,
      this.detector,
      cfg.logs.persistence.enabled,
      cfg.logs.persistence.directory,
      this.sessionID,
      cfg.logs.persistence.retention_days,
      cfg.logs.persistence.max_session_logs,
    );
    this.procs = new ProcessManager();
    this.tokens = deps?.tokens ?? new TokenManager(cfg.auth.refresh_threshold_seconds * 1000, googleTokenProviders(), this.bus);
    this.bus.subscribe((ev) => {
      const payload = ev.payload ?? {};
      const message =
        ev.type === TokenRefreshed
          ? `token refreshed identity=${String(payload.identity ?? "")}`
          : ev.type === TokenRefreshFailed
            ? `token refresh failed identity=${String(payload.identity ?? "")} audience=${String(payload.audience ?? "")}: ${String(payload.error ?? "")}`
            : `authentication changed user=${String(payload.user ?? "")}`;
      this.logs.append({
        timestamp: new Date().toISOString(),
        service: "auth",
        source: "auth",
        level: ev.type === TokenRefreshFailed ? "WARN" : "INFO",
        message,
        pid: 0,
      });
    }, [TokenRefreshed, TokenRefreshFailed, AuthenticationChanged]);
    this.identityCache = emptyIdentitySnapshot(cfg);
    for (const name of Object.keys(cfg.services)) {
      this.runtimes.set(name, emptyRuntime(name));
    }
  }

  async run(opts?: { autoStartProxy?: boolean }): Promise<void> {
    const socket = socketPath(this.cfg.repoRoot);
    // Windows named pipes are not filesystem entries and vanish with the
    // process that held them; existsSync/unlinkSync do not apply.
    if (process.platform !== "win32" && existsSync(socket)) {
      try {
        unlinkSync(socket);
      } catch {
        this.log("devctl", "WARN", "unable to remove stale socket");
      }
    }
    this.lock = acquireLock(this.cfg.repoRoot, socket);
    this.registry = await loadPluginPaths(this.cfg.plugins.map((plugin) => plugin.path));
    this.applyRegistry();
    this.checkPluginHealthTypes();
    this.checkPluginIdentityTypes();
    await this.recoverSession();
    this.watchConfig();
    this.persistState();
    this.log("devctl", "INFO", `supervisor started session=${this.sessionID}`);
    void this.refreshIdentity();
    this.resourceTimer = setInterval(() => void this.pollResourceUsage(), RESOURCE_POLL_MS);
    if (this.cfg.proxy.enabled && opts?.autoStartProxy !== false) {
      await this.startProxy().catch((err) => this.log("devctl", "ERROR", humanMessage(err)));
    }
    await new Promise<void>((resolve, reject) => {
      this.server = createServer((socketConn) => {
        this.handleConn(socketConn);
      });
      this.server.on("error", reject);
      this.server.listen(socket, () => resolve());
    });
  }

  private handleConn(socketConn: import("node:net").Socket): void {
    let buf = "";
    // Bound the outgoing queue so a slow reader under a high-frequency log
    // stream can't grow memory without limit. Only pure event pushes (no
    // `id`) are droppable — an RPC response always carries an `id` and the
    // client would hang forever waiting for it, so those are never dropped.
    const MAX_QUEUED_EVENTS = 2000;
    const queue: Envelope[] = [];
    let waitingForDrain = false;
    const pump = (): void => {
      while (queue.length > 0) {
        const env = queue[0];
        const ok = socketConn.write(`${JSON.stringify(env)}\n`);
        queue.shift();
        if (!ok) {
          waitingForDrain = true;
          socketConn.once("drain", () => {
            waitingForDrain = false;
            pump();
          });
          return;
        }
      }
    };
    const write = (env: Envelope): void => {
      const droppable = env.id === undefined && env.event !== undefined;
      if (droppable && queue.length >= MAX_QUEUED_EVENTS) {
        // Evict the oldest droppable entry specifically — not index 0, which
        // may be an RPC response the client is blocked waiting on. If the
        // queue is entirely RPC responses, let it grow; that's fine, RPCs
        // aren't the high-frequency case this cap exists for.
        const i = queue.findIndex((e) => e.id === undefined && e.event !== undefined);
        if (i >= 0) {
          queue.splice(i, 1);
        }
      }
      queue.push(env);
      if (!waitingForDrain) {
        pump();
      }
    };
    const unsub = this.bus.subscribe((event) => write({ event }));
    socketConn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") {
          continue;
        }
        void this.dispatchLine(line, write);
      }
    });
    socketConn.on("close", () => unsub());
  }

  private async dispatchLine(line: string, write: (env: Envelope) => void): Promise<void> {
    let env: Envelope;
    try {
      env = JSON.parse(line) as Envelope;
    } catch {
      write({ error: "invalid json" });
      return;
    }
    try {
      const result = await this.dispatch(env.method ?? "", env.params);
      write({ id: env.id, result });
    } catch (err) {
      const serialized = serializeError(err);
      write({ id: env.id, error: serialized.error, kind: serialized.kind, hint: serialized.hint, service: serialized.service });
    }
  }

  async dispatch(method: string, params: unknown): Promise<unknown> {
    const rec = isRecord(params) ? params : {};
    switch (method) {
      case "ping":
        return { session: this.sessionID };
      case "start":
        return this.start({
          services: asStringArray(rec.services),
          profile: typeof rec.profile === "string" ? rec.profile : "",
          detach: rec.detach === true,
        });
      case "stop":
        await this.stop(asStringArray(rec.services));
        return null;
      case "restart":
        await this.restart(asStringArray(rec.services));
        return null;
      case "auth_refresh":
        this.tokens.invalidate();
        await this.refreshIdentity();
        return this.snapshot().identity;
      case "status":
        return this.snapshot();
      case "logs":
        return this.queryLogs({
          services: asStringArray(rec.services),
          level: typeof rec.level === "string" ? rec.level : "",
          search: typeof rec.search === "string" ? rec.search : "",
          regex: rec.regex === true,
          source: typeof rec.source === "string" ? rec.source : "",
          since: typeof rec.since === "string" ? rec.since : "",
          until: typeof rec.until === "string" ? rec.until : "",
          export: typeof rec.export === "string" ? rec.export : "",
        });
      case "proxy_start":
        await this.startProxy();
        return null;
      case "proxy_stop":
        await this.stopProxy();
        return null;
      case "mcp_start":
        await this.startMcp(typeof rec.port === "number" ? rec.port : undefined);
        return null;
      case "mcp_stop":
        await this.stopMcp();
        return null;
      case "reload":
        return this.reload();
      case "logs_clear":
        this.logs.clear();
        return null;
      case "auth_invalidate":
        this.tokens.invalidate();
        return null;
      case "shutdown":
        const stopServices = typeof rec.stop_services === "boolean" ? rec.stop_services : stopOnExit(this.cfg.shutdown);
        setTimeout(() => {
          void this.shutdown(stopServices);
        }, 50);
        return null;
      default:
        throw newError(KindGeneral, `unknown method ${method}`);
    }
  }

  isDetached(): boolean {
    return this.detached;
  }

  async start(req: StartRequest): Promise<Plan> {
    if (req.detach === true) {
      this.detached = true;
    }
    const resolved = resolveStartRequest(this.cfg, {
      services: req.services,
      profile: req.profile,
      activeProfile: this.profile,
    });
    if (resolved.profile) {
      this.profile = resolved.profile;
    }
    this.profileEnv = resolved.env;
    const plan = startupPlan(this.cfg, resolved.services, resolved.profile);
    const google = await this.detectGoogleFn(this.cfg.google.project_id);
    plan.blockers = identityBlockers(this.cfg, plan.waves.flat(), google.adcAvailable);
    const blocked = new Set(plan.blockers.map((blocker) => blocker.name));
    for (const blocker of plan.blockers) {
      await this.fail(blocker.name, newError(KindProcessStart, blocker.message));
    }
    if (this.cfg.proxy.enabled) {
      await this.startProxy().catch((err) => this.log("devctl", "ERROR", humanMessage(err)));
    }
    const pending: string[] = [];
    for (const name of plan.waves.flat()) {
      if (blocked.has(name) || (await this.claimIfAlreadyUp(name))) {
        continue;
      }
      pending.push(name);
    }
    if (pending.length > 0) {
      try {
        const assigned = await assignPorts(this.cfg, pending, Object.fromEntries(this.ports));
        for (const [name, ports] of Object.entries(assigned)) {
          this.ports.set(name, ports);
          const summary = Object.entries(ports).map(([portName, value]) => `${portName}=${value}`).join(", ");
          this.log(name, "INFO", `assigned ports: ${summary || "none"}`);
        }
      } catch (err) {
        const name = err instanceof DevctlError && err.service !== "" ? err.service : pending[0];
        if (name) {
          await this.fail(name, err);
        }
        throw err;
      }
    }
    for (const wave of plan.waves) {
      const launch = wave.filter((name) => pending.includes(name));
      if (launch.length > 0) {
        const results = await Promise.allSettled(launch.map((name) => this.startOne(name, resolved.env)));
        let waveFailed = false;
        for (const result of results) {
          if (result.status === "rejected") {
            waveFailed = true;
            this.log("devctl", "ERROR", humanMessage(result.reason));
          }
        }
        if (waveFailed) {
          throw newError(KindProcessStart, "one or more services failed to start");
        }
      }
      try {
        await this.awaitWaveHealth(wave);
      } catch (err) {
        this.log("devctl", "ERROR", humanMessage(err));
        throw err;
      }
    }
    this.persistState();
    return plan;
  }

  private serviceIsActive(name: string): boolean {
    const handle = this.procs.get(name);
    if (handle && handleStillRunning(handle)) {
      return true;
    }
    const current = this.runtimes.get(name);
    if (!current) {
      return false;
    }
    if (current.health === HealthHealthy || current.state === StateHealthy) {
      return true;
    }
    // RESTARTING has no live process (pid is cleared in onExit) — it must not
    // count as active, or the scheduled restart's startOne() call would see
    // itself as already up and bail out without ever spawning a new process.
    return current.state === StateStarting || current.state === StateRunning;
  }

  private serviceWorkDir(svc: ServiceConfig): string {
    if (svc.working_dir !== "" && !isAbsolute(svc.working_dir)) {
      return join(this.cfg.repoRoot, svc.working_dir);
    }
    return svc.working_dir;
  }

  private async claimIfAlreadyUp(name: string): Promise<boolean> {
    const svc = this.cfg.services[name];
    if (this.serviceIsActive(name)) {
      if (svc && !this.ports.has(name)) {
        const occupied = await occupiedFixedPorts(svc);
        if (occupied) {
          this.ports.set(name, occupied);
        }
      }
      return true;
    }
    if (!svc) {
      return false;
    }
    const occupied = await occupiedFixedPorts(svc);
    if (!occupied) {
      return false;
    }
    const first = Object.values(occupied)[0];
    const holder = first === undefined ? undefined : await findPortHolder(first);
    const pid = holder?.pid ?? 0;
    if (pid > 0 && pid !== process.pid) {
      const persistedRec = readPersistedState(this.cfg.repoRoot)?.processes.find((rec) => rec.name === name && rec.pid === pid);
      if (!persistedRec) {
        // No prior record ties this pid to this service. Matching on
        // command + cwd alone isn't enough to safely adopt — a same-command
        // process started independently of devctl would satisfy that too —
        // so without a persisted start-time to corroborate identity, treat
        // the port as unavailable rather than adopting.
        this.log(name, "WARN", `port ${first} is held by pid ${pid} with no persisted record for ${name}; not adopting`);
        return false;
      }
      const observed = await inspectProcess(pid);
      const identityOk =
        observed !== undefined &&
        observed.command !== "" &&
        sameProcess(
          {
            args: [...svc.command.args],
            workDir: this.serviceWorkDir(svc),
            startTime: new Date(persistedRec.startTime),
          },
          observed,
        );
      if (identityOk) {
        this.ports.set(name, occupied);
        this.attachProcess(name, pid, [...svc.command.args], this.serviceWorkDir(svc), new Date());
        this.setState(name, StateRunning, HealthUnknown, pid, "");
        this.log(name, "INFO", `already listening on ${Object.values(occupied).join(", ")}; not starting again`);
        this.startHealth(name, svc, pid, occupied, this.serviceWorkDir(svc), {});
        return true;
      }
      this.log(name, "WARN", `port ${first} is in use by an unrelated process (pid ${pid}); not adopting`);
    }
    return false;
  }

  private async startOne(name: string, profileEnv: Record<string, string>): Promise<void> {
    if (this.serviceIsActive(name)) {
      return;
    }
    const svc = this.cfg.services[name];
    if (!svc) {
      throw newError(KindGeneral, `unknown service ${name}`);
    }
    this.setState(name, StateStarting, HealthUnknown, 0, "");
    let ident = fromConfig(svc.identity);
    if (requiresCloud(ident)) {
      try {
        ident = await resolveIdentity(svc.identity, () => detectIdentity(this.cfg.google.project_id), this.registry?.identityProviders);
        if (ident.kind === "service_account") {
          await this.tokens.get(tokenIdentityKey(ident), "", []);
        }
      } catch (err) {
        if (requiresCloudCapability(svc) || ident.kind === "service_account") {
          await this.fail(name, err);
          throw err;
        }
        this.log(name, "WARN", "cloud identity unavailable; starting service locally");
      }
    }
    const assigned = this.ports.get(name) ?? {};
    let proxyURL = "";
    if (this.proxy?.isRunning()) {
      proxyURL = `http://${this.proxy.address()}`;
    } else if (this.cfg.proxy.enabled) {
      proxyURL = `http://${listenAddress(this.cfg.proxy.listen)}`;
    }
    const runtimeEnv = runtimeForService(name, "127.0.0.1", assigned, proxyURL, this.cfg.project.name);
    runtimeEnv.DEVCTL_INTERNAL_TOKEN = this.internalTok;
    if (this.cfg.proxy.token_endpoint.enabled) {
      runtimeEnv.DEVCTL_TOKEN_URL = this.boundTokenURL || `http://127.0.0.1:${this.tokenEP?.listenPort() || this.cfg.proxy.token_endpoint.port}/token`;
    }
    const env = await resolveEnvironment(this.cfg.repoRoot, {
      service: name,
      profile: this.profile,
      serviceCfg: svc,
      profileEnv,
      assignedPorts: assigned,
      runtime: runtimeEnv,
      cfg: this.cfg,
      fetchSecret: secretManagerFetcher(async () => (await this.tokens.get("user", "", [])).accessToken),
      pluginSources: this.registry?.environmentSources,
    });
    let workDir = svc.working_dir;
    if (workDir !== "" && !isAbsolute(workDir)) {
      workDir = join(this.cfg.repoRoot, workDir);
    }
    const handle = await this.procs.start({
      name,
      args: [...svc.command.args],
      shell: svc.shell || svc.command.shell,
      workDir,
      env: envList(env),
      graceMs: graceSeconds(this.cfg.shutdown) * 1000,
      captureStdout: captureStdout(svc),
      captureStderr: captureStderr(svc),
      onLine: (stream, line) => {
        this.logs.append({
          timestamp: new Date().toISOString(),
          service: name,
          source: stream,
          stream,
          level: "",
          message: line,
          pid: handle.pid,
        });
      },
      onExit: (code, err) => {
        this.onExit(name, code, err);
      },
    });
    this.processMeta.set(name, { command: [...svc.command.args], cwd: workDir, startTime: handle.startTime });
    this.setState(name, StateRunning, HealthUnknown, handle.pid, "");
    this.bus.publish(newEvent(ServiceStarted, name, { pid: handle.pid }));
    this.startHealth(name, svc, handle.pid, assigned, workDir, envList(env));
    if (svc.startup.wait_for_healthy) {
      const timeout = svc.startup.timeout_seconds > 0 ? svc.startup.timeout_seconds * 1000 : DEFAULT_STARTUP_TIMEOUT_MS;
      try {
        await this.waitHealthy(name, timeout);
      } catch (err) {
        await this.fail(name, err);
        throw err;
      }
    }
  }

  private async awaitWaveHealth(wave: string[]): Promise<void> {
    for (const name of wave) {
      const svc = this.cfg.services[name];
      if (!svc || svc.health.type === "") {
        continue;
      }
      const timeout = svc.startup.timeout_seconds > 0 ? svc.startup.timeout_seconds * 1000 : DEFAULT_STARTUP_TIMEOUT_MS;
      try {
        await this.waitHealthy(name, timeout);
      } catch (err) {
        await this.fail(name, err);
        throw err;
      }
    }
  }

  private async waitHealthy(name: string, timeout: number): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const rt = this.runtimes.get(name);
      if (rt?.health === HealthHealthy) {
        return;
      }
      if (rt?.state === StateFailed) {
        throw newError(KindHealthCheck, `service ${name} failed while waiting for healthy`);
      }
      await sleep(HEALTH_POLL_MS);
    }
    throw newError(KindHealthCheck, `service ${name} did not become healthy in time`);
  }

  private onExit(name: string, code: number, waitErr?: Error): void {
    const rt = this.runtimes.get(name);
    if (rt && (rt.state === StateStopping || rt.state === StateStopped)) {
      this.setState(name, StateStopped, HealthUnknown, 0, "");
      this.bus.publish(newEvent(ServiceStopped, name, { code }));
      return;
    }
    const svc = this.cfg.services[name];
    const policy = svc ? (svc.restart.policy || (svc.restart.enabled ? "on_failure" : "never")) : "never";
    const msg = waitErr?.message ?? `exited with code ${code}`;
    const should = policy === "always" || (policy === "on_failure" && code !== 0);
    const n = this.restarts.get(name) ?? 0;
    const max = svc && svc.restart.max_retries > 0 ? svc.restart.max_retries : DEFAULT_MAX_RETRIES;
    if (should && n < max) {
      this.setState(name, StateRestarting, HealthUnknown, 0, msg);
      const backoff = svc && svc.restart.backoff_seconds > 0 ? svc.restart.backoff_seconds : DEFAULT_BACKOFF_SECONDS;
      this.bumpRestartCount(name, n + 1);
      setTimeout(() => {
        void this.startOne(name, this.profileEnv).catch((err) => this.log(name, "ERROR", humanMessage(err)));
      }, backoff * (2 ** n) * 1000);
      return;
    }
    void this.fail(name, newError("process_start", msg));
  }

  private startHealth(
    name: string,
    svc: ServiceConfig,
    pid: number,
    assigned: Record<string, number>,
    workDir: string,
    env: Record<string, string>,
  ): void {
    const prev = this.healthTimers.get(name);
    if (prev) {
      clearInterval(prev);
    }
    if (svc.health.type === "") {
      this.setHealth(name, HealthHealthy, "no health check");
      return;
    }
    const interval = healthIntervalMs(svc.health) || DEFAULT_HEALTH_INTERVAL_MS;
    const tick = (): void => {
      void checkHealth(svc.health, pid, assigned, workDir, env, this.registry?.healthChecks).then((res) => {
        this.setHealth(name, res.status, res.message);
        this.logs.append({
          timestamp: new Date().toISOString(),
          service: name,
          source: "health",
          level: healthLevel(res.status),
          message: `health ${res.status} ${res.message}`,
          pid,
        });
        this.maybeRestartUnhealthy(name, svc, res.status);
      });
    };
    tick();
    this.healthTimers.set(name, setInterval(tick, interval));
  }

  async stop(names: string[]): Promise<void> {
    let selected = names;
    if (selected.length === 0) {
      selected = [...this.runtimes.entries()]
        .filter(([, rt]) => rt.state !== StateStopped)
        .map(([name]) => name);
    }
    if (selected.length === 0) {
      return;
    }
    const plan = shutdownPlan(this.cfg, selected);
    const grace = graceSeconds(this.cfg.shutdown) * 1000;
    for (const wave of plan.waves) {
      await Promise.all(
        wave.map(async (name) => {
          this.setState(name, StateStopping, HealthUnknown, 0, "");
          const timer = this.healthTimers.get(name);
          if (timer) {
            clearInterval(timer);
            this.healthTimers.delete(name);
          }
          await this.procs.stop(name, grace);
          await this.releasePorts(name);
          this.setState(name, StateStopped, HealthUnknown, 0, "");
          this.bus.publish(newEvent(ServiceStopped, name, {}));
        }),
      );
    }
    this.persistState();
  }

  async restart(names: string[]): Promise<void> {
    await this.stop(names);
    await this.start({ services: names, profile: this.profile });
  }

  async startProxy(): Promise<void> {
    if (this.proxy?.isRunning()) {
      return;
    }
    this.proxy = new ProxyServer(this.cfg.proxy, this.tokens, this.logs, this.bus, this.detector, this.registry?.proxyMiddleware ?? []);
    await this.proxy.start();
    if (this.cfg.proxy.token_endpoint.enabled) {
      this.tokenEP = new TokenEndpoint(
        this.cfg.proxy.token_endpoint.host || "127.0.0.1",
        this.cfg.proxy.token_endpoint.port,
        this.internalTok,
        this.tokens,
      );
      await this.tokenEP.start();
      this.boundTokenURL = `http://127.0.0.1:${this.tokenEP.listenPort()}/token`;
    }
    this.persistState();
  }

  async stopProxy(): Promise<void> {
    await this.proxy?.stop();
    await this.tokenEP?.stop();
    this.persistState();
  }

  async startMcp(port?: number): Promise<void> {
    if (this.mcp?.isRunning()) {
      return;
    }
    const resolved = await resolveMcpPort(this.cfg.repoRoot, port);
    this.mcp = new McpHttpServer({
      host: "127.0.0.1",
      port: resolved,
      token: this.mcpToken,
      hostApi: this.asMcpHost(),
      onEvent: (level, message) => this.log("mcp", level, `mcp ${message}`),
    });
    await this.mcp.start();
    this.persistState();
  }

  async stopMcp(): Promise<void> {
    await this.mcp?.stop();
    this.mcp = undefined;
    this.persistState();
  }

  private asMcpHost(): McpHost {
    return {
      status: () => this.snapshot(),
      logs: (req) => this.queryLogs(req).events,
      config: () => this.cfg,
      start: (req) => this.start(req),
      stop: (names) => this.stop(names),
      restart: (names) => this.restart(names),
      reload: () => this.reload(),
      doctor: () => runDoctor(this.cfg),
    };
  }

  async reload(): Promise<ReloadResult> {
    const next = load(this.cfg.repoRoot, this.cfg.configPath);
    const result = diffReload(this.cfg, next);
    const proxyChanged = JSON.stringify(this.cfg.proxy) !== JSON.stringify(next.proxy);
    const secretsChanged = JSON.stringify(this.cfg.secrets) !== JSON.stringify(next.secrets);
    Object.assign(this.cfg, next);
    this.restartRequired = result.restart_required;
    // Detector is a cheap, stateless holder of markers/patterns — update it
    // in place so the LogManager/ProxyServer instances that already hold a
    // reference to it see the new rules immediately. LogManager and the
    // plugin registry are deliberately NOT rebuilt here: recreating
    // LogManager would drop the in-memory log ring buffer and start a new
    // persistence session out from under the TUI, which is worse than
    // asking for a restart; reloading plugins mid-session is out of scope.
    if (secretsChanged) {
      this.detector.update(next.secrets.extra_markers, next.secrets.extra_patterns);
    }
    if (proxyChanged) {
      const wasRunning = this.proxy?.isRunning() ?? false;
      await this.stopProxy();
      if (wasRunning && this.cfg.proxy.enabled) {
        await this.startProxy();
      }
      this.log("devctl", "INFO", "proxy configuration changed; proxy restarted");
    }
    this.bus.publish(
      newEvent(ConfigurationChanged, "", {
        restart_required: result.restart_required,
        changes: result.changes,
        supervisor_restart_required: result.supervisor_restart_required,
      }),
    );
    this.log("devctl", "INFO", result.restart_required.length === 0 ? "configuration reloaded" : `configuration reloaded; restart required: ${result.restart_required.join(", ")}`);
    if (result.supervisor_restart_required) {
      this.log(
        "devctl",
        "WARN",
        `configuration changed in ${result.supervisor_restart_required.join(", ")} — these only take effect after a full \`devctl stop && devctl start\`, not a reload`,
      );
    }
    this.persistState();
    void this.refreshIdentity();
    return result;
  }

  async shutdown(stopServices: boolean): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    if (stopServices) {
      await this.stop([]);
    }
    await this.stopProxy();
    await this.stopMcp();
    this.configWatcher?.close();
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    if (this.resourceTimer) {
      clearInterval(this.resourceTimer);
    }
    this.server?.close();
    this.lock?.release();
    await this.logs.close();
  }

  snapshot(): StatusSnapshot {
    const services: Record<string, Runtime> = {};
    for (const [name, rt] of this.runtimes) {
      services[name] = { ...rt, ports: this.ports.get(name) ?? rt.ports };
    }
    return {
      session_id: this.sessionID,
      repo_root: this.cfg.repoRoot,
      profile: this.profile,
      services,
      proxy: {
        running: this.proxy?.isRunning() ?? false,
        address: this.proxy?.address(),
        routes: this.cfg.proxy.routes.map((r) => ({
          name: r.name,
          identity: r.auth.identity.service_account || r.auth.identity.type || r.auth.type,
          upstream: r.upstream.url,
          auth: r.auth.type,
        })),
      },
      mcp: {
        running: this.mcp?.isRunning() ?? false,
        address: this.mcp?.isRunning() ? `http://${this.mcp.address()}/mcp` : undefined,
        port: this.mcp?.isRunning() ? this.mcp.listenPort() : undefined,
        token: this.mcpToken,
      },
      identity: { ...this.identityCache },
      credentials: {
        backend: this.tokens.storeBackend(),
        entries: [...this.credentialEntries],
      },
      detached: this.detached,
      logs: this.logs.snapshot(),
      restart_required: [...this.restartRequired],
      system: systemSnapshot(),
    };
  }

  async refreshIdentity(): Promise<void> {
    try {
      const st = await this.detectGoogleFn(this.cfg.google.project_id);
      const accounts: Record<string, boolean> = {};
      for (const email of configuredServiceAccounts(this.cfg)) {
        accounts[email] = await this.probeServiceAccount(email);
      }
      this.identityCache = {
        user: st.userEmail,
        project: st.projectID || this.cfg.google.project_id,
        project_source: st.projectSource || (this.cfg.google.project_id ? "configuration" : ""),
        adc: st.adcAvailable,
        service_accounts: accounts,
        iap: this.cfg.proxy.routes.some((route) => route.auth.type.toLowerCase() === "iap"),
      };
      this.credentialEntries = (await this.tokens.listStatus()).map((entry) => ({
        identity: entry.identity,
        audience: entry.audience,
        expires_at: entry.expires_at,
        valid: entry.valid,
      }));
      this.bus.publish(newEvent(AuthenticationChanged, "", { user: this.identityCache.user, adc: this.identityCache.adc }));
      this.log("auth", "INFO", `authentication changed user=${this.identityCache.user || "(unknown)"} adc=${this.identityCache.adc}`);
      this.persistState();
    } catch (err) {
      this.log("devctl", "WARN", `identity refresh failed: ${humanMessage(err)}`);
    }
  }

  private async probeServiceAccount(email: string): Promise<boolean> {
    try {
      await withTimeout(this.tokens.get(`sa:${email}`, "", []), IDENTITY_PROBE_MS);
      return true;
    } catch {
      return false;
    }
  }

  queryLogs(req: LogsRequest): { events: LogEvent[] } {
    const events = this.logs.query({
      services: req.services,
      level: req.level,
      search: req.search,
      regex: req.regex,
      source: req.source,
      since: req.since,
      until: req.until,
    });
    if (req.export) {
      this.logs.exportTo(req.export, {
        services: req.services,
        level: req.level,
        search: req.search,
        regex: req.regex,
        source: req.source,
        since: req.since,
        until: req.until,
      });
    }
    return { events };
  }

  subscribe(handler: (event: import("./events.ts").BusEvent) => void): () => void {
    return this.bus.subscribe(handler);
  }

  formatStatus(): string {
    const snap = this.snapshot();
    const lines = [`PROFILE: ${snap.profile || "(none)"}`, "", "SERVICE\tSTATUS\tHEALTH\tPID"];
    for (const [name, rt] of Object.entries(snap.services)) {
      lines.push(`${name}\t${displayState(rt)}\t${rt.health}\t${rt.pid}`);
    }
    lines.push("", `PROXY       ${snap.proxy.running ? "RUNNING" : "STOPPED"}     ${snap.proxy.address ?? ""}`);
    lines.push(`MCP         ${snap.mcp?.running ? "RUNNING" : "STOPPED"}     ${snap.mcp?.address ?? ""}`);
    return lines.join("\n") + "\n";
  }

  private setState(name: string, state: ServiceState, health: ServiceHealth, pid: number, lastError: string): void {
    const rt = this.runtimes.get(name) ?? emptyRuntime(name);
    rt.state = state;
    rt.health = health;
    rt.pid = pid;
    rt.last_error = lastError;
    const keepUsage = state === StateRunning || state === StateHealthy || state === StateUnhealthy;
    rt.startTime = keepUsage ? this.processMeta.get(name)?.startTime.toISOString() : undefined;
    if (!keepUsage) {
      rt.cpuPercent = undefined;
      rt.memoryKB = undefined;
    }
    this.runtimes.set(name, rt);
    this.bus.publish(newEvent(ServiceStateChanged, name, { state, health, pid }));
  }

  // this.restarts (the private retry-budget counter) and Runtime.restarts
  // (the field sent to clients) must stay in sync — bump both together so
  // status snapshots reflect real restart counts instead of always 0.
  private bumpRestartCount(name: string, n: number): void {
    this.restarts.set(name, n);
    const rt = this.runtimes.get(name);
    if (rt) {
      rt.restarts = n;
    }
  }

  // Runtimes only carry a pid; CPU/memory are sampled out-of-band via `ps`
  // on an interval rather than tracked per state transition, since they
  // change continuously while a process runs.
  private async pollResourceUsage(): Promise<void> {
    const pids: number[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.pid > 0 && (rt.state === StateRunning || rt.state === StateHealthy || rt.state === StateUnhealthy)) {
        pids.push(rt.pid);
      }
    }
    if (pids.length === 0) {
      return;
    }
    const samples = await sampleResourceUsage(pids);
    for (const rt of this.runtimes.values()) {
      const sample = rt.pid > 0 ? samples.get(rt.pid) : undefined;
      if (sample) {
        rt.cpuPercent = sample.cpuPercent;
        rt.memoryKB = sample.memoryKB;
      }
    }
  }

  private setHealth(name: string, health: ServiceHealth, message: string): void {
    const rt = this.runtimes.get(name);
    if (!rt) {
      return;
    }
    rt.health = health;
    if (rt.state === StateRunning || rt.state === StateHealthy || rt.state === StateUnhealthy) {
      rt.state = health === HealthHealthy ? StateHealthy : health === HealthUnhealthy ? StateUnhealthy : rt.state;
    }
    this.bus.publish(newEvent(ServiceHealthChanged, name, { health, message }));
  }

  private maybeRestartUnhealthy(name: string, svc: ServiceConfig, health: ServiceHealth): void {
    if (health !== HealthUnhealthy) {
      this.unhealthyStreak.set(name, 0);
      return;
    }
    const policy = svc.restart.policy || (svc.restart.enabled ? "on_failure" : "never");
    if (policy !== "on_failure" && policy !== "always") {
      return;
    }
    const streak = (this.unhealthyStreak.get(name) ?? 0) + 1;
    this.unhealthyStreak.set(name, streak);
    if (streak < HEALTH_RESTART_STREAK) {
      return;
    }
    this.unhealthyStreak.set(name, 0);
    // Share the same restart budget and backoff as crash-triggered restarts
    // (onExit) so a service that is merely unhealthy but never exits can't
    // restart forever at a fixed 3-checks-per-restart cadence.
    const n = this.restarts.get(name) ?? 0;
    const max = svc.restart.max_retries > 0 ? svc.restart.max_retries : DEFAULT_MAX_RETRIES;
    if (n >= max) {
      this.log(name, "WARN", `unhealthy after ${streak} consecutive checks but the restart limit (${max}) has already been reached; not restarting`);
      return;
    }
    const backoff = svc.restart.backoff_seconds > 0 ? svc.restart.backoff_seconds : DEFAULT_BACKOFF_SECONDS;
    this.bumpRestartCount(name, n + 1);
    this.log(name, "WARN", `restarting after ${streak} consecutive unhealthy checks (attempt ${n + 1}/${max})`);
    setTimeout(() => {
      void this.restart([name]).catch((err) => this.log(name, "ERROR", humanMessage(err)));
    }, backoff * (2 ** n) * 1000);
  }

  private applyRegistry(): void {
    if (!this.registry) {
      return;
    }
    if (this.registry.tokenProviders.length > 0) {
      this.tokens.replaceProviders(this.registry.tokenProviders);
    }
    this.logs.setParsers(this.registry.logParsers);
  }

  // validate() lets a non-builtin health.type through when cfg.plugins is
  // non-empty, since plugins aren't loaded yet at config-parse time. Now
  // that they are, confirm each such type actually resolved to a registered
  // health check plugin.
  private checkPluginHealthTypes(): void {
    const unresolved = unresolvedHealthTypes(this.cfg);
    if (unresolved.length === 0) {
      return;
    }
    // checkHealth() matches plugin name to health.type case-insensitively; mirror that here.
    const known = new Set((this.registry?.healthChecks ?? []).map((check) => check.name.toLowerCase()));
    const stillUnknown = unresolved.filter((entry) => !known.has(entry.type.toLowerCase()));
    if (stillUnknown.length > 0) {
      throw newError(
        KindConfiguration,
        `unknown health check type(s): ${stillUnknown.map((entry) => `${entry.service}.health.type=${entry.type}`).join(", ")}`,
      );
    }
  }

  // Mirrors checkPluginHealthTypes: validate() lets a non-builtin
  // identity.type through when cfg.plugins is non-empty, since plugins
  // aren't loaded yet at config-parse time. Confirm each such type actually
  // resolved to a registered identity provider now that they are.
  private checkPluginIdentityTypes(): void {
    const unresolved = unresolvedIdentityTypes(this.cfg);
    if (unresolved.length === 0) {
      return;
    }
    // userIdentityProvider() accepts anything that isn't a service account,
    // so it would silently "resolve" any custom type as a Google user
    // identity if we checked the full provider list. Only a provider other
    // than the two builtins counts as actually resolving a custom type.
    const pluginProviders = (this.registry?.identityProviders ?? []).filter((provider) => provider.name !== "user" && provider.name !== "service_account");
    const stillUnknown = unresolved.filter(({ service }) => {
      const svc = this.cfg.services[service];
      return !svc || !pluginProviders.some((provider) => provider.accepts(svc.identity));
    });
    if (stillUnknown.length > 0) {
      throw newError(
        KindConfiguration,
        `unknown identity type(s): ${stillUnknown.map((entry) => `${entry.service}.identity.type=${entry.type}`).join(", ")}`,
      );
    }
  }

  private watchConfig(): void {
    const dir = join(this.cfg.repoRoot, ".devctl");
    if (!existsSync(dir)) {
      return;
    }
    try {
      this.configWatcher = watch(dir, { recursive: true }, () => {
        if (this.watchTimer) {
          clearTimeout(this.watchTimer);
        }
        this.watchTimer = setTimeout(() => {
          void this.reload().catch((err) => this.log("devctl", "WARN", humanMessage(err)));
        }, WATCH_DEBOUNCE_MS);
      });
    } catch {
      this.log("devctl", "WARN", "unable to watch .devctl for configuration changes");
    }
  }

  private async releasePorts(name: string): Promise<void> {
    const ports = this.ports.get(name);
    if (!ports) {
      return;
    }
    const svc = this.cfg.services[name];
    const meta = this.processMeta.get(name);
    for (const port of Object.values(ports)) {
      const holder = await findPortHolder(port);
      if (!holder || holder.pid === process.pid) {
        continue;
      }
      if (svc) {
        const observed = await inspectProcess(holder.pid);
        const identityOk =
          observed !== undefined &&
          observed.command !== "" &&
          sameProcess(
            {
              args: meta?.command ?? [...svc.command.args],
              workDir: meta?.cwd ?? this.serviceWorkDir(svc),
              startTime: meta?.startTime,
            },
            observed,
          );
        if (!identityOk) {
          this.log(name, "WARN", `port ${port} is held by pid ${holder.pid}, which does not match ${name}; leaving it running`);
          continue;
        }
      }
      try {
        await freePort(holder);
        this.log(name, "INFO", `released port ${port} (pid ${holder.pid})`);
      } catch (err) {
        this.log(name, "WARN", humanMessage(err));
      }
    }
    this.ports.delete(name);
  }

  private async fail(name: string, err: unknown): Promise<void> {
    const timer = this.healthTimers.get(name);
    if (timer) {
      clearInterval(timer);
      this.healthTimers.delete(name);
    }
    try {
      await this.procs.stop(name, graceSeconds(this.cfg.shutdown) * 1000);
    } catch (stopErr) {
      this.log(name, "WARN", humanMessage(stopErr));
    }
    this.setState(name, StateFailed, HealthUnknown, 0, humanMessage(err));
    this.bus.publish(newEvent(ServiceFailed, name, { error: humanMessage(err) }));
    this.log(name, "ERROR", humanMessage(err));
  }

  private log(service: string, level: string, message: string): void {
    this.logs.append({
      timestamp: new Date().toISOString(),
      service,
      source: "devctl",
      level,
      message,
      pid: 0,
    });
  }

  private persistState(): void {
    const processes = [];
    for (const handle of this.procs.all()) {
      const meta = this.processMeta.get(handle.name);
      processes.push({
        name: handle.name,
        pid: handle.pid,
        command: meta?.command ?? handle.args,
        cwd: meta?.cwd ?? handle.workDir,
        startTime: (meta?.startTime ?? handle.startTime).toISOString(),
        ports: this.ports.get(handle.name) ?? {},
      });
    }
    writePersistedState(this.cfg.repoRoot, {
      session_id: this.sessionID,
      repo_root: this.cfg.repoRoot,
      profile: this.profile,
      processes,
    });
  }

  private attachProcess(name: string, pid: number, args: string[], workDir: string, startTime: Date): void {
    if (this.procs.get(name) && this.processAliveFn(this.procs.get(name)?.pid ?? 0)) {
      return;
    }
    if (!this.processAliveFn(pid) || pid === process.pid) {
      return;
    }
    try {
      this.procs.adopt({
        name,
        pid,
        args,
        workDir,
        startTime,
        onExit: (code, err) => {
          this.onExit(name, code, err);
        },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.log(name, "WARN", `adopt pid ${pid} failed (${detail}); tracking leftover in snapshot only`);
    }
    this.processMeta.set(name, { command: args, cwd: workDir, startTime });
  }

  private async recoverSession(): Promise<void> {
    const persisted = readPersistedState(this.cfg.repoRoot);
    if (!persisted || persisted.processes.length === 0) {
      return;
    }
    const adopted: string[] = [];
    for (const rec of persisted.processes) {
      if (!this.cfg.services[rec.name] || rec.pid <= 0 || rec.pid === process.pid || !this.processAliveFn(rec.pid)) {
        continue;
      }
      const observed = await this.inspectProcessFn(rec.pid);
      const identityOk =
        observed !== undefined &&
        observed.command !== "" &&
        sameProcess({ args: rec.command, workDir: rec.cwd, startTime: rec.startTime ? new Date(rec.startTime) : undefined }, observed);
      if (!identityOk) {
        const portOk =
          Object.values(rec.ports).length > 0 &&
          (await occupiedFixedPorts({
            ports: Object.entries(rec.ports).map(([pname, value]) => ({ name: pname, value, auto: false })),
          })) !== undefined;
        if (portOk) {
          this.log(rec.name, "WARN", `pid ${rec.pid} does not match stored command; leftover listener not adopted`);
        } else {
          this.log(rec.name, "WARN", `pid ${rec.pid} is a different process; not adopting`);
        }
        continue;
      }
      this.attachProcess(rec.name, rec.pid, rec.command, rec.cwd, new Date(rec.startTime || Date.now()));
      if (Object.keys(rec.ports).length > 0) {
        this.ports.set(rec.name, rec.ports);
      }
      this.setState(rec.name, StateRunning, HealthUnknown, rec.pid, "");
      const svc = this.cfg.services[rec.name];
      if (svc) {
        this.startHealth(rec.name, svc, rec.pid, rec.ports, rec.cwd || this.serviceWorkDir(svc), {});
      }
      this.log(rec.name, "INFO", "adopted leftover process; stdout/stderr from before adopt are not captured");
      adopted.push(rec.name);
    }
    if (adopted.length > 0) {
      this.profile = persisted.profile || this.profile;
      this.bus.publish(newEvent(SessionRecovered, "", { services: adopted, session_id: persisted.session_id }));
      this.log("devctl", "INFO", `recovered session processes: ${adopted.join(", ")}`);
    }
  }
}

export function diffReload(prev: DevctlConfig, next: DevctlConfig): ReloadResult {
  const changes: Record<string, string[]> = {};
  const restart = new Set<string>();
  const names = new Set([...Object.keys(prev.services), ...Object.keys(next.services)]);
  for (const name of names) {
    const before = prev.services[name];
    const after = next.services[name];
    const fields: string[] = [];
    if (!before || !after) {
      fields.push("presence");
      restart.add(name);
    } else {
      if (
        before.command.args.join("\0") !== after.command.args.join("\0") ||
        before.command.shell !== after.command.shell ||
        before.shell !== after.shell
      ) {
        fields.push("command");
        restart.add(name);
      }
      if (before.working_dir !== after.working_dir) {
        fields.push("working_dir");
        restart.add(name);
      }
      if (JSON.stringify(before.environment) !== JSON.stringify(after.environment)) {
        fields.push("environment");
        restart.add(name);
      }
      if (JSON.stringify(before.ports) !== JSON.stringify(after.ports)) {
        fields.push("ports");
        restart.add(name);
      }
      if (JSON.stringify(before.identity) !== JSON.stringify(after.identity)) {
        fields.push("identity");
        restart.add(name);
      }
      if (JSON.stringify(before.health) !== JSON.stringify(after.health)) {
        fields.push("health");
        restart.add(name);
      }
      if (JSON.stringify(before.restart) !== JSON.stringify(after.restart)) {
        fields.push("restart");
        restart.add(name);
      }
      if (JSON.stringify(before.startup) !== JSON.stringify(after.startup)) {
        fields.push("startup");
        restart.add(name);
      }
      if (JSON.stringify(before.logs) !== JSON.stringify(after.logs)) {
        fields.push("logs");
        restart.add(name);
      }
    }
    if (fields.length > 0) {
      changes[name] = fields;
    }
  }
  const supervisorRestart: string[] = [];
  if (JSON.stringify(prev.logs) !== JSON.stringify(next.logs)) {
    supervisorRestart.push("logs");
  }
  if (JSON.stringify(prev.auth) !== JSON.stringify(next.auth)) {
    supervisorRestart.push("auth");
  }
  if (JSON.stringify(prev.plugins) !== JSON.stringify(next.plugins)) {
    supervisorRestart.push("plugins");
  }
  return {
    restart_required: [...restart].sort(),
    changes,
    supervisor_restart_required: supervisorRestart.length > 0 ? supervisorRestart : undefined,
  };
}

function emptyIdentitySnapshot(cfg?: DevctlConfig): IdentitySnapshot {
  return {
    user: "",
    project: cfg?.google.project_id ?? "",
    project_source: cfg?.google.project_id ? "configuration" : "",
    adc: false,
    service_accounts: Object.fromEntries(cfg ? configuredServiceAccounts(cfg).map((email) => [email, false]) : []),
    iap: cfg?.proxy.routes.some((route) => route.auth.type.toLowerCase() === "iap") ?? false,
  };
}

function systemSnapshot(): SystemSnapshot {
  const avg = loadavg();
  const mem = readHostMemory();
  return {
    platform: platform(),
    cpuCount: cpus().length,
    loadAvg1: avg[0] ?? 0,
    loadAvg5: avg[1] ?? 0,
    loadAvg15: avg[2] ?? 0,
    memTotalKB: mem.totalKB,
    memFreeKB: mem.unusedKB,
    memAvailableKB: mem.leftoverKB,
    hostUptimeSec: uptime(),
  };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("identity probe timed out")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function requiresCloudCapability(svc: ServiceConfig): boolean {
  return svc.capabilities.some((c) => ["google_api", "iap", "service_identity"].includes(c));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { formatPlan };
