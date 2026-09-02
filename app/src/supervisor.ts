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
import { DevctlError, KindConfiguration, KindGeneral, KindHealthCheck, KindProcessStart, KindServiceNotFound, humanMessage, newError, serializeError } from "./errors.ts";
import {
  AuthenticationChanged,
  Bus,
  ConfigurationChanged,
  ConfigurationReloadFailed,
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
import { loadTuiConfig } from "./tui/tui-config.ts";
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
  dependentsClosure,
  displayState,
  emptyRuntime,
  formatPlan,
  resolveStartRequest,
  shutdownPlan,
  shutdownPlanExact,
  startupPlan,
  type Plan,
  type Runtime,
  type ServiceHealth,
  type ServiceState,
} from "./services.ts";
import { acquireLock, newSessionID, randomSecret, readOrCreateMcpToken, readPersistedState, socketPath, writePersistedState } from "./storage.ts";
import { TokenManager, googleTokenProviders } from "./token.ts";
import type { Envelope, IdentitySnapshot, LogsRequest, ReloadResult, ServiceAccountStatus, StartRequest, StatusSnapshot, SystemSnapshot } from "./types.ts";
import { RPC_PROTOCOL_VERSION, VERSION } from "./version.ts";

const IDENTITY_PROBE_MS = 4_000;
const HEALTH_POLL_MS = 100;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_SECONDS = 2;
const DEFAULT_HEALTH_INTERVAL_MS = 2000;
const WATCH_DEBOUNCE_MS = 200;
const HEALTH_RESTART_STREAK = 3;
// Consecutive healthy checks that count a service as stable enough to
// forgive its past crashes/unhealthy spells — otherwise a service that has
// run fine for hours could still hit max_retries and fail outright on its
// next stumble, purely because of failures long in its past.
const HEALTH_RESET_STREAK = 10;
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
  // Set only by an explicit "proxy_stop" RPC, cleared only by an explicit
  // "proxy_start" one — never by reload() or an internal stopProxy() call
  // (config change, shutdown) — so a user who deliberately stopped the
  // proxy doesn't have it silently come back on the next service start.
  private proxySuppressed = false;
  private mcp?: McpHttpServer;
  private readonly mcpToken: string;
  private tokenEP?: TokenEndpoint;
  private profile = "";
  // Per-service: the OS environment of whichever client (CLI/TUI) most
  // recently started/restarted it, in memory only. A service that has never
  // been started/restarted by a real client this way — an MCP-initiated
  // start, or a process adopted by recoverSession() — has no entry, and
  // resolveEnvironment() falls back to the daemon's own environment. This is
  // intentionally never persisted: it does not survive a daemon replacement,
  // which must be restarted by a real client to pick up fresh env again.
  private readonly clientEnv = new Map<string, Record<string, string>>();
  // Per-service: the profile (name + resolved env) in effect the last time
  // this service was explicitly (re)started. Read by onExit's crash-restart
  // and restart()'s own respawn so that starting a *different* service under
  // a different profile — which moves the daemon-wide this.profile/
  // this.profileEnv used as the fallback below — can never change what an
  // unrelated, already-running service's next automatic restart resolves
  // its environment with. Same never-persisted rationale as clientEnv.
  private readonly serviceProfile = new Map<string, string>();
  private readonly serviceProfileEnv = new Map<string, Record<string, string>>();
  // Bumped on every event that ends a service's current lifecycle epoch —
  // a fresh spawn, an adopted process, an explicit stop, or a terminal
  // failure — so an exit, health-check, or scheduled-restart callback
  // captured under an older epoch can recognize it's stale (something newer
  // already superseded it) and become a no-op instead of acting on state
  // that belongs to a different process than the one it was scheduled for.
  private readonly generation = new Map<string, number>();
  private readonly runtimes = new Map<string, Runtime>();
  private readonly ports = new Map<string, Record<string, number>>();
  private readonly healthTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly restarts = new Map<string, number>();
  private lock?: { release: () => void };
  private server?: Server;
  private shuttingDown = false;
  private detached = false;
  private identityCache: IdentitySnapshot = emptyIdentitySnapshot();
  // Cached probe results, keyed by service account email — populated
  // lazily (a service actually using the identity, an explicit auth_refresh,
  // or a doctor inspection), never by the automatic refresh that runs at
  // boot and after every reload, which only ever updates ADC/user/project.
  // An email with no entry here is "unknown", not "unavailable" — see
  // serviceAccountSnapshot().
  private readonly serviceAccountStatus = new Map<string, ServiceAccountStatus>();
  private readonly detectGoogleFn: (project: string) => Promise<GoogleStatus>;
  private readonly inspectProcessFn: (pid: number) => Promise<ProcessIdentity | undefined>;
  private readonly processAliveFn: (pid: number) => boolean;
  private readonly acquireLockFn: (repoRoot: string, socket: string) => { release: () => void };
  private readonly socketExistsFn: (socket: string) => boolean;
  private readonly unlinkSocketFn: (socket: string) => void;
  private registry?: Registry;
  private restartRequired: string[] = [];
  private readonly processMeta = new Map<string, { command: string[]; cwd: string; startTime: Date }>();
  private credentialEntries: Array<{ identity: string; audience: string; expires_at: string; valid: boolean }> = [];
  private boundTokenURL = "";
  private configWatcher?: FSWatcher;
  private watchTimer?: ReturnType<typeof setTimeout>;
  private readonly unhealthyStreak = new Map<string, number>();
  private readonly healthyStreak = new Map<string, number>();
  private readonly restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private profileEnv: Record<string, string> = {};
  private resourceTimer?: ReturnType<typeof setInterval>;

  constructor(
    cfg: DevctlConfig,
    deps?: {
      detectGoogle?: (project: string) => Promise<GoogleStatus>;
      tokens?: TokenManager;
      inspectProcess?: (pid: number) => Promise<ProcessIdentity | undefined>;
      processAlive?: (pid: number) => boolean;
      acquireLock?: (repoRoot: string, socket: string) => { release: () => void };
      socketExists?: (socket: string) => boolean;
      unlinkSocket?: (socket: string) => void;
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
    this.acquireLockFn = deps?.acquireLock ?? acquireLock;
    this.socketExistsFn = deps?.socketExists ?? existsSync;
    this.unlinkSocketFn = deps?.unlinkSocket ?? unlinkSync;
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

  async run(): Promise<void> {
    const socket = socketPath(this.cfg.repoRoot);
    // Acquire the lock BEFORE touching the socket file. acquireLock() is what
    // proves no live supervisor already owns this repo; deleting the socket
    // first (the old order) let a losing second process unlink a *live*
    // peer's bound socket before discovering — via the lock — that it had
    // lost the race, leaving the winner still running but unreachable.
    this.lock = this.acquireLockFn(this.cfg.repoRoot, socket);
    this.removeStaleSocket(socket);
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
    // MCP boot must not depend on which client happens to spawn or first
    // attach to this daemon (CLI vs TUI): read the user's saved preference
    // directly here rather than relying on a client to apply it.
    const tuiPrefs = loadTuiConfig(this.cfg.repoRoot);
    if (tuiPrefs.mcp_enabled) {
      await this.startMcp(tuiPrefs.mcp_port).catch((err) => this.log("devctl", "ERROR", humanMessage(err)));
    }
    // Lazy, sticky proxy policy: startup never binds it. The first start()
    // call auto-starts it (see start() below) unless the user has
    // explicitly suppressed it with `proxy stop`.
    // Recheck immediately before binding: still holding the lock acquired
    // above, so anything now at this path is necessarily stale (nothing else
    // can have won the lock in the meantime) — but the plugin/session work
    // above this point had await points, so re-verify rather than trust the
    // check from before them.
    this.removeStaleSocket(socket);
    await new Promise<void>((resolve, reject) => {
      this.server = createServer((socketConn) => {
        this.handleConn(socketConn);
      });
      this.server.on("error", reject);
      this.server.listen(socket, () => resolve());
    });
  }

  private removeStaleSocket(socket: string): void {
    // Windows named pipes are not filesystem entries and vanish with the
    // process that held them; existsSync/unlinkSync do not apply.
    if (process.platform === "win32") {
      return;
    }
    if (this.socketExistsFn(socket)) {
      try {
        this.unlinkSocketFn(socket);
      } catch {
        this.log("devctl", "WARN", "unable to remove stale socket");
      }
    }
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
        return { session: this.sessionID, version: VERSION, protocol: RPC_PROTOCOL_VERSION };
      case "start":
        return this.start({
          services: asStringArray(rec.services),
          profile: typeof rec.profile === "string" ? rec.profile : "",
          detach: rec.detach === true,
          client_env: asStringRecord(rec.client_env),
        });
      case "stop":
        await this.stop(asStringArray(rec.services));
        return null;
      case "restart":
        await this.restart(asStringArray(rec.services), { cascade: rec.cascade === true, clientEnv: asStringRecord(rec.client_env) });
        return null;
      case "auth_refresh":
        this.tokens.invalidate();
        await this.refreshIdentity({ probeServiceAccounts: true });
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
        // Only an explicit proxy_start clears suppression — startProxy()
        // itself is also called from start() and reload(), which must not
        // have this side effect.
        this.proxySuppressed = false;
        await this.startProxy();
        return null;
      case "proxy_stop":
        this.proxySuppressed = true;
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
      case "config_snapshot":
        // Local RPC only — never exposed through MCP. Returns the last-
        // known-good in-memory config with real values intact (not
        // redacted): the TUI is the one deciding whether to display them,
        // via the same Detector-based redaction it already applies
        // elsewhere unless the user has explicitly turned on /reveal.
        return this.cfg;
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
    // Only a request that actually carries a client_env replaces the stored
    // fallback for these services — an MCP-initiated or internally-triggered
    // start (never a real client) must not blank out an earlier real one.
    if (req.client_env) {
      for (const name of resolved.services) {
        this.clientEnv.set(name, req.client_env);
      }
    }
    // Every explicit start (client or MCP-initiated) records the profile
    // context it resolved for each named service — see serviceProfile.
    for (const name of resolved.services) {
      this.serviceProfile.set(name, resolved.profile);
      this.serviceProfileEnv.set(name, resolved.env);
    }
    // A real start request forgives past restarts for everything it names —
    // see resetRestartCount. `auto` marks a start restart() issued for its
    // own automatic (health-triggered) relaunch, which must preserve the
    // count armRestart's caller just bumped rather than immediately erase it.
    if (req.auto !== true) {
      for (const name of resolved.services) {
        this.resetRestartCount(name);
      }
    }
    const plan = startupPlan(this.cfg, resolved.services, resolved.profile);
    const google = await this.detectGoogleFn(this.cfg.google.project_id);
    plan.blockers = identityBlockers(this.cfg, plan.waves.flat(), google.adcAvailable);
    const blocked = new Set(plan.blockers.map((blocker) => blocker.name));
    for (const blocker of plan.blockers) {
      await this.fail(blocker.name, newError(KindProcessStart, blocker.message));
    }
    if (this.cfg.proxy.enabled && !this.proxySuppressed) {
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
        // Fail exactly the service a structured error names — never guess by
        // blaming pending[0]: an error unrelated to that service (a port
        // conflict discovered while assigning a *later* one, say) must not
        // mark it failed just because it happened to be first in the list.
        // With no real attribution, this is a global failure: log it and let
        // it propagate, without marking any particular service failed.
        if (err instanceof DevctlError && err.service !== "") {
          await this.fail(err.service, err);
        } else {
          this.log("devctl", "ERROR", humanMessage(err));
        }
        throw err;
      }
    }
    for (const wave of plan.waves) {
      const launch = wave.filter((name) => pending.includes(name));
      if (launch.length > 0) {
        const results = await Promise.allSettled(launch.map((name) => this.startOne(name, resolved.profile, resolved.env)));
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
        // Use the persisted start time, not "now" — this process has been
        // running since persistedRec.startTime (that's exactly what
        // sameProcess() above just verified); reporting "now" would both
        // show a bogus near-zero uptime and, once this adoption is itself
        // persisted, poison the record a future adoption verifies identity
        // against.
        const gen = this.attachProcess(name, pid, [...svc.command.args], this.serviceWorkDir(svc), new Date(persistedRec.startTime)) ?? this.bumpGeneration(name);
        this.setState(name, StateRunning, HealthUnknown, pid, "");
        this.log(name, "INFO", `already listening on ${Object.values(occupied).join(", ")}; not starting again`);
        const workDir = this.serviceWorkDir(svc);
        const healthEnv = await this.resolveAdoptedHealthEnv(name, svc, occupied);
        this.startHealth(name, svc, pid, occupied, workDir, healthEnv, gen);
        return true;
      }
      this.log(name, "WARN", `port ${first} is in use by an unrelated process (pid ${pid}); not adopting`);
    }
    return false;
  }

  private async startOne(name: string, profile: string, profileEnv: Record<string, string>): Promise<void> {
    if (this.serviceIsActive(name)) {
      return;
    }
    const svc = this.cfg.services[name];
    if (!svc) {
      throw newError(KindGeneral, `unknown service ${name}`);
    }
    this.setState(name, StateStarting, HealthUnknown, 0, "");
    const gen = this.bumpGeneration(name);
    let ident = fromConfig(svc.identity);
    if (requiresCloud(ident)) {
      try {
        ident = await resolveIdentity(svc.identity, () => detectIdentity(this.cfg.google.project_id), this.registry?.identityProviders);
        if (ident.kind === "service_account") {
          await this.tokens.get(tokenIdentityKey(ident), "", []);
          // First real use of this identity — cache the result so status
          // reflects it without waiting for an explicit refresh or doctor
          // inspection to get around to probing it.
          this.serviceAccountStatus.set(ident.serviceAccount, "available");
        }
      } catch (err) {
        if (ident.kind === "service_account") {
          this.serviceAccountStatus.set(ident.serviceAccount, "unavailable");
        }
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
      profile,
      serviceCfg: svc,
      profileEnv,
      assignedPorts: assigned,
      runtime: runtimeEnv,
      cfg: this.cfg,
      fetchSecret: secretManagerFetcher(async () => (await this.tokens.get("user", "", [])).accessToken),
      pluginSources: this.registry?.environmentSources,
      clientEnv: this.clientEnv.get(name),
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
        this.onExit(name, gen, code, err);
      },
    });
    this.processMeta.set(name, { command: [...svc.command.args], cwd: workDir, startTime: handle.startTime });
    this.setState(name, StateRunning, HealthUnknown, handle.pid, "");
    this.bus.publish(newEvent(ServiceStarted, name, { pid: handle.pid }));
    this.startHealth(name, svc, handle.pid, assigned, workDir, envList(env), gen);
    // Persist right after a successful spawn — not batched at the end of
    // start()'s whole plan — so a crash-restart's respawn (which never goes
    // through start() at all) and an earlier wave's processes both survive
    // a daemon crash even when a later wave or health wait goes on to fail.
    this.persistState();
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

  // Reconstructs a reproducible environment for an adopted process's health
  // checks. recoverSession()/claimIfAlreadyUp() adopt a process devctl
  // itself never spawned this session — its real launch environment isn't
  // persisted (and for a leftover from a previous daemon, no longer exists
  // to read back) — so a command-type health check given no environment at
  // all can't even resolve PATH to find its own executable. This recomputes
  // one from the same configured, reproducible sources a fresh start would
  // use (profile, dotenv, defaults/vars, secrets, runtime) with no
  // client_env of course, falling back to just the daemon's own
  // environment — a usable baseline PATH at minimum — if resolution itself
  // fails, e.g. a required var only a now-vanished client ever supplied.
  private async resolveAdoptedHealthEnv(name: string, svc: ServiceConfig, assigned: Record<string, number>): Promise<Record<string, string>> {
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
    try {
      const env = await resolveEnvironment(this.cfg.repoRoot, {
        service: name,
        profile: this.serviceProfile.get(name) ?? this.profile,
        serviceCfg: svc,
        profileEnv: this.serviceProfileEnv.get(name) ?? this.profileEnv,
        assignedPorts: assigned,
        runtime: runtimeEnv,
        cfg: this.cfg,
        fetchSecret: secretManagerFetcher(async () => (await this.tokens.get("user", "", [])).accessToken),
        pluginSources: this.registry?.environmentSources,
      });
      return envList(env);
    } catch (err) {
      this.log(name, "WARN", `could not fully reconstruct environment for adopted service's health check (${humanMessage(err)}); using a baseline environment`);
      return envList(runtimeEnv);
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

  private onExit(name: string, gen: number, code: number, waitErr?: Error): void {
    // This exit belongs to a process from an epoch stop()/fail()/a newer
    // start already ended — whatever it implies about restart policy no
    // longer applies to whatever (if anything) currently holds this name.
    if (!this.isCurrentGeneration(name, gen)) {
      return;
    }
    const rt = this.runtimes.get(name);
    if (rt?.state === StateFailed) {
      // fail() already set this state and is in the middle of killing the
      // process on purpose (e.g. a startup health-check timeout); the exit
      // that kill produces must not be treated as a crash to restart from.
      return;
    }
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
    if (should && svc && n < max) {
      this.setState(name, StateRestarting, HealthUnknown, 0, msg);
      this.bumpRestartCount(name, n + 1);
      // The process that just exited is already gone from procs.all() (the
      // ProcessManager removes it before invoking this callback), so this
      // promptly clears its now-dead pid from disk instead of leaving a
      // stale record there until some unrelated later event persists again.
      this.persistState();
      this.armRestart(name, svc, gen, n, () => {
        // Use this service's own last-tracked profile context, not the
        // daemon-wide fallback — an unrelated service started under a
        // different profile in the meantime must not change what this one
        // crash-restarts with.
        const profile = this.serviceProfile.get(name) ?? this.profile;
        const profileEnv = this.serviceProfileEnv.get(name) ?? this.profileEnv;
        void this.startOne(name, profile, profileEnv).catch((err) => this.log(name, "ERROR", humanMessage(err)));
      });
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
    gen: number,
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
      void checkHealth(svc.health, pid, assigned, workDir, env, this.registry?.healthChecks)
        .catch((err: unknown) => ({ status: HealthUnhealthy, message: humanMessage(err) }) as const)
        .then((res) => {
          // A slow check (e.g. an HTTP request against a hung endpoint) can
          // still be in flight when this service crashes and restarts under
          // a new pid; without this guard its stale result would land on
          // whatever process now holds this service's name instead.
          if (!this.isCurrentGeneration(name, gen)) {
            return;
          }
          this.setHealth(name, res.status, res.message);
          this.logs.append({
            timestamp: new Date().toISOString(),
            service: name,
            source: "health",
            level: healthLevel(res.status),
            message: `health ${res.status} ${res.message}`,
            pid,
          });
          this.maybeRestartUnhealthy(name, svc, res.status, gen);
        });
    };
    tick();
    this.healthTimers.set(name, setInterval(tick, interval));
  }

  // stop x also stops everything that (transitively) depends on x, never
  // x's own dependencies — see shutdownPlan. Empty names stops every
  // currently-active service but leaves the daemon itself running.
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
    // An orphaned service (removed from configuration by a reload while
    // still running — see reconcileServices) has no dependency graph left
    // to plan against; only a genuinely unknown name should still fail
    // closed the way shutdownPlan's requireKnown would.
    const orphaned = selected.filter((name) => !this.cfg.services[name] && this.runtimes.has(name));
    const trulyUnknown = selected.filter((name) => !this.cfg.services[name] && !this.runtimes.has(name));
    if (trulyUnknown.length > 0) {
      throw newError(KindServiceNotFound, `unknown service "${trulyUnknown[0]}"`);
    }
    const known = selected.filter((name) => this.cfg.services[name] !== undefined);
    if (known.length > 0) {
      // A user-initiated stop always forgives past restarts — see
      // resetRestartCount — for every service the plan touches, including
      // dependents pulled in by the cascade, not just the named service(s).
      await this.runStopPlan(shutdownPlan(this.cfg, known), { resetRestartCounts: true });
    }
    if (orphaned.length > 0) {
      // No config means no dependency graph to cascade through — stop
      // exactly the orphaned services named, each its own wave, then drop
      // their tracking entirely: nothing (config or process) is left for
      // it to describe.
      await this.runStopPlan({ profile: this.profile, steps: [], waves: orphaned.map((name) => [name]) }, { resetRestartCounts: true });
      for (const name of orphaned) {
        this.forgetService(name);
      }
    }
  }

  // Drops every trace of a service that no longer has a configuration
  // entry and isn't running — called both when a reload removes an
  // already-stopped service and after an orphaned one is explicitly
  // stopped. Safe to call on a service that was never tracked at all.
  private forgetService(name: string): void {
    const timer = this.healthTimers.get(name);
    if (timer) {
      clearInterval(timer);
      this.healthTimers.delete(name);
    }
    this.clearRestartTimer(name);
    this.runtimes.delete(name);
    this.ports.delete(name);
    this.processMeta.delete(name);
    this.clientEnv.delete(name);
    this.serviceProfile.delete(name);
    this.serviceProfileEnv.delete(name);
    this.restarts.delete(name);
    this.generation.delete(name);
    this.unhealthyStreak.delete(name);
    this.healthyStreak.delete(name);
  }

  // After a reload, cfg.services no longer necessarily matches what's
  // actually tracked. A newly added service gets a STOPPED runtime entry
  // right away instead of silently not existing until first started. A
  // removed service that's already stopped is forgotten outright; one
  // still running is marked orphaned (see Runtime.orphaned) and left
  // alone — stop() can still reach it by name — rather than silently
  // dropped with no way to stop it short of a full `down`.
  private reconcileServices(prevServices: Record<string, ServiceConfig>, nextServices: Record<string, ServiceConfig>): void {
    for (const name of Object.keys(nextServices)) {
      if (!prevServices[name] && !this.runtimes.has(name)) {
        this.runtimes.set(name, emptyRuntime(name));
      }
    }
    for (const name of Object.keys(prevServices)) {
      if (nextServices[name]) {
        continue;
      }
      if (this.serviceIsActive(name)) {
        const rt = this.runtimes.get(name);
        if (rt) {
          rt.orphaned = true;
        }
        this.log(name, "WARN", "removed from configuration while still running; now orphaned — stop it explicitly to clean it up");
        continue;
      }
      this.forgetService(name);
    }
  }

  // Plain restart touches only the named services — never their
  // dependents — matching stop's "never dependencies" rule in spirit: a
  // restart is a minimal, targeted action unless the caller explicitly
  // opts into the wider blast radius of `cascade`, which restarts the same
  // dependents shutdownPlan/stop would have stopped.
  //
  // `auto` marks a restart the supervisor scheduled itself (a health-check
  // failure via maybeRestartUnhealthy) rather than one a real client asked
  // for. Only a real client's restart forgives past restarts; an automatic
  // one must preserve the count armRestart's caller just bumped, or the
  // max_retries budget it exists to enforce would reset itself every cycle.
  async restart(names: string[], opts?: { cascade?: boolean; clientEnv?: Record<string, string>; auto?: boolean }): Promise<void> {
    const cascade = opts?.cascade === true;
    const targets = cascade ? dependentsClosure(this.cfg, names) : names;
    const plan = cascade ? shutdownPlan(this.cfg, names) : shutdownPlanExact(this.cfg, names);
    const manual = opts?.auto !== true;
    await this.runStopPlan(plan, { resetRestartCounts: manual });
    // Reuse whichever of these targets already has its own tracked profile
    // context (see serviceProfile) rather than the daemon-wide this.profile,
    // which an unrelated service's start may have since moved on from.
    const profile = targets.map((name) => this.serviceProfile.get(name)).find((p) => p !== undefined) ?? this.profile;
    await this.start({ services: targets, profile, client_env: opts?.clientEnv, auto: opts?.auto });
  }

  private async runStopPlan(plan: Plan, opts?: { resetRestartCounts?: boolean }): Promise<void> {
    // A crash or unhealthy restart scheduled just before this call must not
    // go on to revive a service the caller explicitly asked to stop —
    // startOne() only checks "is it already active", which a stopped
    // service is not. Bumping the generation is belt-and-suspenders for the
    // same reason: it also invalidates any exit/health callback still in
    // flight from the process this call is about to kill. This covers
    // every service the plan actually touches, including dependents pulled
    // in by a cascade — not just whatever the caller explicitly named.
    for (const name of plan.waves.flat()) {
      this.clearRestartTimer(name);
      this.bumpGeneration(name);
      if (opts?.resetRestartCounts) {
        this.resetRestartCount(name);
      }
    }
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
      restart: (names, cascade) => this.restart(names, { cascade }),
      reload: () => this.reload(),
      doctor: async () => {
        // Explicit doctor inspection is one of the three things allowed to
        // actually probe service accounts (the others: first use, an
        // explicit auth_refresh) — never the automatic boot/reload refresh.
        for (const email of configuredServiceAccounts(this.cfg)) {
          await this.probeServiceAccount(email);
        }
        return runDoctor(this.cfg);
      },
    };
  }

  async reload(): Promise<ReloadResult> {
    let next: DevctlConfig;
    try {
      next = load(this.cfg.repoRoot, this.cfg.configPath);
    } catch (err) {
      // this.cfg is untouched at this point, so the daemon keeps running on
      // its last-known-good config — but an already-attached client (which
      // didn't necessarily initiate this reload; e.g. the config-file
      // watcher did) has no other way to learn the reload it's about to see
      // reflected in config_snapshot silently failed, so publish it.
      this.bus.publish(newEvent(ConfigurationReloadFailed, "", { error: humanMessage(err) }));
      this.log("devctl", "ERROR", `configuration reload failed: ${humanMessage(err)}`);
      throw err;
    }
    try {
      // Revalidate against the candidate config, not this.cfg — a newly
      // added service (or one whose health/identity type just changed)
      // referencing a plugin type nothing provides should reject the
      // reload the same way an unparseable config file does, rather than
      // silently taking effect and only surfacing once someone starts it.
      this.checkPluginHealthTypes(next);
      this.checkPluginIdentityTypes(next);
    } catch (err) {
      this.bus.publish(newEvent(ConfigurationReloadFailed, "", { error: humanMessage(err) }));
      this.log("devctl", "ERROR", `configuration reload failed: ${humanMessage(err)}`);
      throw err;
    }
    const result = diffReload(this.cfg, next);
    const proxyChanged = JSON.stringify(this.cfg.proxy) !== JSON.stringify(next.proxy);
    const secretsChanged = JSON.stringify(this.cfg.secrets) !== JSON.stringify(next.secrets);
    const prevServices = this.cfg.services;
    Object.assign(this.cfg, next);
    this.reconcileServices(prevServices, next.services);
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
    // Flush current state before anything else — most importantly for the
    // detach case (stopServices=false): the process list persisted here is
    // exactly what a later `devctl start`/`status` reads back to adopt the
    // still-running services this call is about to walk away from.
    // writeFileSecure() writes it atomically, so a crash or SIGKILL right
    // after this point can't leave a truncated state.json behind.
    this.persistState();
    if (stopServices) {
      await this.stop([]);
    }
    this.clearAllRestartTimers();
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
      services[name] = {
        ...rt,
        ports: this.ports.get(name) ?? rt.ports,
        profile: this.serviceProfile.get(name) ?? rt.profile,
        env_source: this.clientEnv.has(name) ? "client" : "daemon",
      };
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
      // service_accounts/service_account_status come from the live cache,
      // not identityCache's snapshot — a first-use probe (startOne) or a
      // doctor inspection updates serviceAccountStatus directly without
      // going through refreshIdentity, and must be visible immediately.
      identity: { ...this.identityCache, ...this.serviceAccountSnapshot() },
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

  // Automatic refresh (boot, after every reload) only ever updates ADC,
  // user, and project metadata — cheap, local checks. Probing every
  // configured service account is comparatively expensive (a real token
  // fetch per identity, each with its own timeout) and only happens when
  // opts.probeServiceAccounts is explicitly set: an "auth_refresh" request
  // or a doctor inspection, never an automatic pass. A service starting
  // under a service-account identity for the first time also updates the
  // cache for that one identity — see startOne.
  async refreshIdentity(opts?: { probeServiceAccounts?: boolean }): Promise<void> {
    try {
      const st = await this.detectGoogleFn(this.cfg.google.project_id);
      if (opts?.probeServiceAccounts) {
        for (const email of configuredServiceAccounts(this.cfg)) {
          await this.probeServiceAccount(email);
        }
      }
      const { service_accounts, service_account_status } = this.serviceAccountSnapshot();
      this.identityCache = {
        user: st.userEmail,
        project: st.projectID || this.cfg.google.project_id,
        project_source: st.projectSource || (this.cfg.google.project_id ? "configuration" : ""),
        adc: st.adcAvailable,
        service_accounts,
        service_account_status,
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

  // Builds the two service-account views the snapshot exposes from the
  // cache alone — never a fresh probe — against the currently configured
  // set of identities, so a reload that adds or removes one is reflected
  // immediately even though nothing has probed the new one yet.
  private serviceAccountSnapshot(): { service_accounts: Record<string, boolean>; service_account_status: Record<string, ServiceAccountStatus> } {
    const service_accounts: Record<string, boolean> = {};
    const service_account_status: Record<string, ServiceAccountStatus> = {};
    for (const email of configuredServiceAccounts(this.cfg)) {
      const status = this.serviceAccountStatus.get(email) ?? "unknown";
      service_account_status[email] = status;
      if (status !== "unknown") {
        service_accounts[email] = status === "available";
      }
    }
    return { service_accounts, service_account_status };
  }

  private async probeServiceAccount(email: string): Promise<ServiceAccountStatus> {
    let status: ServiceAccountStatus;
    try {
      await withTimeout(this.tokens.get(`sa:${email}`, "", []), IDENTITY_PROBE_MS);
      status = "available";
    } catch {
      status = "unavailable";
    }
    this.serviceAccountStatus.set(email, status);
    return status;
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

  // A manual stop or start is the caller taking explicit control of this
  // service; whatever crash history it had stops mattering from here — it
  // gets a fresh restart budget rather than staying close to max_retries
  // because of failures from before this intervention.
  private resetRestartCount(name: string): void {
    this.healthyStreak.set(name, 0);
    this.bumpRestartCount(name, 0);
  }

  // Ends the current lifecycle epoch for a service: any exit, health-check,
  // or scheduled-restart callback still holding an older generation number
  // is now stale and must recognize that via isCurrentGeneration() rather
  // than act on state that belongs to a different process.
  private bumpGeneration(name: string): number {
    const next = (this.generation.get(name) ?? 0) + 1;
    this.generation.set(name, next);
    // A new epoch starts its own healthy streak from zero — otherwise a
    // streak built up before a crash could carry over and forgive that very
    // crash's restart-count bump on the next tick, without the service ever
    // actually proving itself stable again under the new process.
    this.healthyStreak.set(name, 0);
    return next;
  }

  private isCurrentGeneration(name: string, gen: number): boolean {
    return this.generation.get(name) === gen;
  }

  // Crash restarts (onExit) and unhealthy restarts (maybeRestartUnhealthy)
  // both schedule a delayed respawn via setTimeout. Tracking the handle lets
  // stop/fail/shutdown cancel it — otherwise a restart scheduled moments
  // before the service is deliberately stopped or fails outright can still
  // fire afterward and resurrect a process the caller just asked to end.
  private scheduleRestart(name: string, delayMs: number, action: () => void): void {
    this.clearRestartTimer(name);
    const timer = setTimeout(() => {
      this.restartTimers.delete(name);
      action();
    }, delayMs);
    this.restartTimers.set(name, timer);
  }

  // Shared by crash-triggered (onExit) and health-triggered
  // (maybeRestartUnhealthy) restarts: computes backoff from the pre-bump
  // attempt count and arms the timer, guarding the eventual fire against a
  // generation that has since moved on — a manual stop/start/restart, or a
  // fail(), already happened for this service — so a stale scheduled
  // restart from a superseded epoch never fires.
  private armRestart(name: string, svc: ServiceConfig, gen: number, attempt: number, action: () => void): void {
    const backoff = svc.restart.backoff_seconds > 0 ? svc.restart.backoff_seconds : DEFAULT_BACKOFF_SECONDS;
    this.scheduleRestart(name, backoff * (2 ** attempt) * 1000, () => {
      if (this.isCurrentGeneration(name, gen)) {
        action();
      }
    });
  }

  private clearRestartTimer(name: string): void {
    const timer = this.restartTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.restartTimers.delete(name);
    }
  }

  private clearAllRestartTimers(): void {
    for (const timer of this.restartTimers.values()) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();
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

  private maybeRestartUnhealthy(name: string, svc: ServiceConfig, health: ServiceHealth, gen: number): void {
    if (health !== HealthUnhealthy) {
      this.unhealthyStreak.set(name, 0);
      if (health === HealthHealthy) {
        this.maybeForgiveRestarts(name);
      }
      return;
    }
    this.healthyStreak.set(name, 0);
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
    this.bumpRestartCount(name, n + 1);
    this.log(name, "WARN", `restarting after ${streak} consecutive unhealthy checks (attempt ${n + 1}/${max})`);
    this.armRestart(name, svc, gen, n, () => {
      void this.restart([name], { auto: true }).catch((err) => this.log(name, "ERROR", humanMessage(err)));
    });
  }

  // Forgives past restarts once a service proves itself stable, so a long
  // healthy run doesn't leave it one stumble away from max_retries because
  // of crashes/unhealthy spells long in its past.
  private maybeForgiveRestarts(name: string): void {
    const streak = (this.healthyStreak.get(name) ?? 0) + 1;
    this.healthyStreak.set(name, streak);
    if (streak >= HEALTH_RESET_STREAK && (this.restarts.get(name) ?? 0) > 0) {
      this.log(name, "INFO", `restart count reset after ${streak} consecutive healthy checks`);
      this.bumpRestartCount(name, 0);
    }
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
  private checkPluginHealthTypes(cfg: DevctlConfig = this.cfg): void {
    const unresolved = unresolvedHealthTypes(cfg);
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
  private checkPluginIdentityTypes(cfg: DevctlConfig = this.cfg): void {
    const unresolved = unresolvedIdentityTypes(cfg);
    if (unresolved.length === 0) {
      return;
    }
    // userIdentityProvider() accepts anything that isn't a service account,
    // so it would silently "resolve" any custom type as a Google user
    // identity if we checked the full provider list. Only a provider other
    // than the two builtins counts as actually resolving a custom type.
    const pluginProviders = (this.registry?.identityProviders ?? []).filter((provider) => provider.name !== "user" && provider.name !== "service_account");
    const stillUnknown = unresolved.filter(({ service }) => {
      const svc = cfg.services[service];
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
    this.clearRestartTimer(name);
    this.bumpGeneration(name);
    // Set FAILED before killing the process, not after: procs.stop() awaits
    // the same exit promise that drives onExit(), and onExit() runs (as part
    // of resolving that promise) before this await returns — so onExit()
    // must already see FAILED at that point to know this exit was ours and
    // skip scheduling a restart for it. (The generation bump above already
    // makes that exit a no-op on its own; the FAILED check stays as a second,
    // independent guard.)
    this.setState(name, StateFailed, HealthUnknown, 0, humanMessage(err));
    try {
      await this.procs.stop(name, graceSeconds(this.cfg.shutdown) * 1000);
    } catch (stopErr) {
      this.log(name, "WARN", humanMessage(stopErr));
    }
    this.bus.publish(newEvent(ServiceFailed, name, { error: humanMessage(err) }));
    this.log(name, "ERROR", humanMessage(err));
    this.persistState();
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

  // Returns the generation this adoption was recorded under, or undefined
  // if nothing was adopted (already tracked and alive, or the pid isn't a
  // live process devctl can attach to) — callers pass whichever they get
  // (bumping their own fallback generation otherwise) through to
  // startHealth() so its tick and this process's onExit agree on the same
  // epoch.
  private attachProcess(name: string, pid: number, args: string[], workDir: string, startTime: Date): number | undefined {
    if (this.procs.get(name) && this.processAliveFn(this.procs.get(name)?.pid ?? 0)) {
      return undefined;
    }
    if (!this.processAliveFn(pid) || pid === process.pid) {
      return undefined;
    }
    const gen = this.bumpGeneration(name);
    try {
      this.procs.adopt({
        name,
        pid,
        args,
        workDir,
        startTime,
        onExit: (code, err) => {
          this.onExit(name, gen, code, err);
        },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.log(name, "WARN", `adopt pid ${pid} failed (${detail}); tracking leftover in snapshot only`);
    }
    this.processMeta.set(name, { command: args, cwd: workDir, startTime });
    this.persistState();
    return gen;
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
      const gen = this.attachProcess(rec.name, rec.pid, rec.command, rec.cwd, new Date(rec.startTime || Date.now())) ?? this.bumpGeneration(rec.name);
      if (Object.keys(rec.ports).length > 0) {
        this.ports.set(rec.name, rec.ports);
      }
      this.setState(rec.name, StateRunning, HealthUnknown, rec.pid, "");
      const svc = this.cfg.services[rec.name];
      if (svc) {
        const workDir = rec.cwd || this.serviceWorkDir(svc);
        const healthEnv = await this.resolveAdoptedHealthEnv(rec.name, svc, rec.ports);
        this.startHealth(rec.name, svc, rec.pid, rec.ports, workDir, healthEnv, gen);
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
    // Nothing has been probed yet — omitted here, not defaulted to false;
    // see service_account_status for the "not probed yet" state itself.
    service_accounts: {},
    service_account_status: Object.fromEntries(cfg ? configuredServiceAccounts(cfg).map((email) => [email, "unknown" as const]) : []),
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

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string") {
      out[key] = val;
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { formatPlan };
