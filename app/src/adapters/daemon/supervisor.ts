import { createServer, type Server } from "node:net";
import type { FSWatcher } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  type DevctlConfig,
  type ServiceConfig,
  type Command,
  emptyService,
  commandEmpty,
  graceSeconds,
  listenAddress,
  validateConfigText,
  stopOnExit,
} from "../config/index.ts";
import { envList, resolveEnvironment, runtimeForService } from "../environment/environment.ts";
import { claimIfAlreadyUp as claimAdoptedService, recoverSession as recoverPersistedSession, type RecoverHost } from "./recover.ts";
import { applyRegistry as applyPluginRegistry, checkPluginEnvironmentSources as assertPluginEnvironmentSources, checkPluginHealthTypes as assertPluginHealthTypes, checkPluginIdentityTypes as assertPluginIdentityTypes, reloadSupervisor, watchConfig as watchConfigDir, type ReloadHost } from "./reload.ts";
import { buildSnapshot, emptyIdentitySnapshot, formatStatusFromSnapshot, serviceAccountSnapshot, type SnapshotHost } from "./snapshot.ts";
import { secretManagerFetcher } from "../google/secret-manager.ts";
import type { LifecycleSession } from "../../ports/lifecycle-session.ts";
import type { DaemonCommandHost, DaemonCommands, ServiceOrchestratorPort } from "../../ports/daemon.ts";
import type { McpHost, McpListener, McpListenerFactory } from "../../ports/mcp-host.ts";
import { configSnapshotDiff } from "../../domain/config/snapshot.ts";
import { canTransition } from "../../domain/service/lifecycle.ts";
import type { Clock } from "../../ports/clock.ts";
import type { FileSystem } from "../../ports/filesystem.ts";
import { DevctlError, KindGeneral, KindProcessStart, KindServiceNotFound, humanMessage, newError, serializeError } from "../../shared/errors.ts";
import {
  AuthenticationChanged,
  type Bus,
  ServiceFailed,
  ServiceStateChanged,
  TokenRefreshed,
  TokenRefreshFailed,
  newEvent,
} from "../../shared/events.ts";
import { detectIdentity, type GoogleStatus } from "../google/google.ts";
import type { HealthCheckerFactory } from "../../ports/health-checker.ts";
import { configuredServiceAccounts, fromConfig, resolveIdentity, tokenIdentityKey } from "../../domain/identity/identity.ts";
import type { LogStore } from "../../ports/log-store.ts";
import type { LogEvent, LogFacets, LogFilter, LogPage, LogPageRequest } from "../../domain/logs/logs.ts";
import { assignPorts, findPortHolder, freePort } from "../net/ports.ts";
import { loadPluginPaths, type Registry } from "../plugins/registry.ts";
import { type ProcessManager, sameProcess, sampleResourceUsage, type ProcessIdentity } from "../process/processes.ts";
import { resolveMcpPort } from "../net/mcp-port.ts";
import { loadTuiConfig } from "../config/tui-preferences.ts";
import { ProxyServer, TokenEndpoint } from "../proxy/proxy.ts";
import { Detector } from "../secrets/detector.ts";
import {
  HealthUnknown,
  StateFailed,
  StateHealthy,
  StateUnhealthy,
  StateRunning,
  emptyRuntime,
  formatPlan,
  type Plan,
  type Runtime,
  type ServiceHealth,
  type ServiceState,
} from "../../domain/service/services.ts";
import { randomSecret, readOrCreateMcpToken, repoID, socketPath, writePersistedState } from "../storage/storage.ts";
import type { TokenManager } from "../google/token.ts";
import type { Envelope } from "../../types.ts";
import type { IdentitySnapshot, LogsRequest, ReloadResult, ServiceAccountStatus, StartRequest, StatusSnapshot } from "../../domain/status.ts";
import { RPC_PROTOCOL_VERSION, VERSION } from "../../version.ts";

const IDENTITY_PROBE_MS = 4_000;
const RESOURCE_POLL_MS = 3_000;

export class Supervisor {
  private cfg: DevctlConfig;
  private readonly sessionID: string;
  private readonly internalTok: string;
  private readonly bus: Bus;
  private readonly logs: LogStore;
  private readonly procs: ProcessManager;
  private readonly tokens: TokenManager;
  private readonly detector: Detector;
  private proxy?: ProxyServer;
  // Set only by an explicit "proxy_stop" RPC, cleared only by an explicit
  // "proxy_start" one — never by reload() or an internal stopProxy() call
  // (config change, shutdown) — so a user who deliberately stopped the
  // proxy doesn't have it silently come back on the next service start.
  private proxySuppressed = false;
  private mcp?: McpListener;
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
  private readonly runtimes = new Map<string, Runtime>();
  private readonly ports = new Map<string, Record<string, number>>();
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
  // No configuration on disk yet — see StatusSnapshot.setup_mode. Cleared by
  // the first reload that successfully loads one.
  private setupMode: boolean;
  // Which MCP tools are turned off. Owned here rather than captured by the
  // MCP server, which reads it through a getter on every request — so a TUI
  // toggle takes effect at once without restarting the listener.
  private mcpDisabledTools: string[] = [];
  private profileEnv: Record<string, string> = {};
  private resourceTimer?: ReturnType<typeof setInterval>;

  private readonly orchestrator: ServiceOrchestratorPort;
  private readonly commands: DaemonCommands;
  private readonly clock: Clock;
  private readonly fs: FileSystem;
  private readonly healthCheckers: HealthCheckerFactory;
  private readonly createMcpListener: McpListenerFactory;
  private readonly isKnownTool: (name: string) => boolean;

  constructor(
    cfg: DevctlConfig,
    deps: {
      healthCheckers: HealthCheckerFactory;
      detectGoogle: (project: string) => Promise<GoogleStatus>;
      tokens: TokenManager;
      inspectProcess: (pid: number) => Promise<ProcessIdentity | undefined>;
      processAlive: (pid: number) => boolean;
      acquireLock: (repoRoot: string, socket: string) => { release: () => void };
      socketExists: (socket: string) => boolean;
      unlinkSocket: (socket: string) => void;
      procs: ProcessManager;
      orchestrator: ServiceOrchestratorPort;
      clock: Clock;
      fs: FileSystem;
      bus: Bus;
      logs: LogStore;
      detector: Detector;
      sessionID: string;
      createMcpListener: McpListenerFactory;
      isKnownTool: (name: string) => boolean;
      createCommands: (host: DaemonCommandHost) => DaemonCommands;
    },
  ) {
    this.healthCheckers = deps.healthCheckers;
    this.cfg = cfg;
    this.sessionID = deps.sessionID;
    this.internalTok = randomSecret();
    this.mcpToken = readOrCreateMcpToken(cfg.repoRoot);
    this.clock = deps.clock;
    this.fs = deps.fs;
    this.bus = deps.bus;
    this.detectGoogleFn = deps.detectGoogle;
    this.inspectProcessFn = deps.inspectProcess;
    this.processAliveFn = deps.processAlive;
    this.acquireLockFn = deps.acquireLock;
    this.socketExistsFn = deps.socketExists;
    this.unlinkSocketFn = deps.unlinkSocket;
    this.detector = deps.detector;
    this.logs = deps.logs;
    this.procs = deps.procs;
    this.orchestrator = deps.orchestrator;
    this.tokens = deps.tokens;
    this.createMcpListener = deps.createMcpListener;
    this.isKnownTool = deps.isKnownTool;
    this.bus.subscribe((ev) => {
      const payload = ev.payload ?? {};
      const message =
        ev.type === TokenRefreshed
          ? `token refreshed identity=${String(payload.identity ?? "")}`
          : ev.type === TokenRefreshFailed
            ? `token refresh failed identity=${String(payload.identity ?? "")} audience=${String(payload.audience ?? "")}: ${String(payload.error ?? "")}`
            : `authentication changed user=${String(payload.user ?? "")}`;
      this.logs.append({
        timestamp: this.clock.isoNow(),
        service: "auth",
        source: "auth",
        level: ev.type === TokenRefreshFailed ? "WARN" : "INFO",
        message,
        pid: 0,
      });
      if (ev.type === TokenRefreshed || ev.type === TokenRefreshFailed) {
        // A proxied request or the token endpoint can mint a fresh token at
        // any time, entirely outside refreshIdentity()'s boot/reload/manual
        // schedule. Without this, the credential store already has the new
        // expiry but the Credentials/Auth screens keep showing whatever
        // refreshIdentity() last cached until the user explicitly refreshes.
        void this.syncCredentialEntries();
      }
    }, [TokenRefreshed, TokenRefreshFailed, AuthenticationChanged]);
    this.setupMode = !this.fs.exists(cfg.configPath);
    this.identityCache = emptyIdentitySnapshot(cfg);
    for (const name of Object.keys(cfg.services)) {
      this.runtimes.set(name, emptyRuntime(name));
    }
    this.orchestrator.bind(this.lifecycleSession());
    this.commands = deps.createCommands(this);
  }

  private toHost<T>(): T {
    this.processAliveFn;
    this.restartRequired;
    this.credentialEntries;
    this.setupMode;
    return this as unknown as T;
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
    this.registry = await loadPluginPaths(this.cfg.plugins.map((plugin) => plugin.path), this.cfg.repoRoot);
    for (const failure of this.registry.loadErrors) this.log("devctl", "ERROR", `plugin ${failure.path} skipped: ${failure.message}`);
    applyPluginRegistry(this.toHost<ReloadHost>());
    assertPluginHealthTypes(this.registry, this.cfg);
    assertPluginIdentityTypes(this.registry, this.cfg);
    assertPluginEnvironmentSources(this.registry, this.cfg);
    await this.recoverSession();
    watchConfigDir(this.toHost<ReloadHost>());
    this.persistState();
    this.log("devctl", "INFO", `supervisor started session=${this.sessionID}`);
    void this.refreshIdentity();
    this.resourceTimer = setInterval(() => void this.pollResourceUsage(), RESOURCE_POLL_MS);
    // MCP boot must not depend on which client happens to spawn or first
    // attach to this daemon (CLI vs TUI): read the user's saved preference
    // directly here rather than relying on a client to apply it.
    const tuiPrefs = loadTuiConfig(this.cfg.repoRoot);
    // Same reasoning as mcp_enabled/mcp_port: the deny-list is a saved user
    // preference, so the daemon applies it itself at boot whether a CLI or
    // TUI client spawned it, rather than waiting for a client to push it.
    this.setMcpDisabledTools(tuiPrefs.mcp_disabled_tools ?? []);
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
    // Without a listener here, Node's default behavior for an unhandled
    // socket 'error' (ECONNRESET/EPIPE from a client that disconnected
    // abruptly — killed, crashed, network blip — mid-write) is to throw,
    // crashing the whole daemon and every other attached client and
    // running service along with it. This is an ordinary disconnect, not a
    // supervisor fault: log it and let the "close" handler below do its
    // usual cleanup.
    socketConn.on("error", (err) => {
      this.log("devctl", "WARN", `client connection error: ${humanMessage(err)}`);
    });
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
        return this.commands.startService.execute({
          services: asStringArray(rec.services),
          profile: typeof rec.profile === "string" ? rec.profile : "",
          detach: rec.detach === true,
          client_env: asStringRecord(rec.client_env),
        });
      case "stop":
        await this.commands.stopService.execute(asStringArray(rec.services));
        return null;
      case "restart":
        await this.commands.restartService.execute(asStringArray(rec.services), { cascade: rec.cascade === true, clientEnv: asStringRecord(rec.client_env) });
        return null;
      case "run_task":
        return this.runTask(typeof rec.name === "string" ? rec.name : "", asStringRecord(rec.client_env) ?? {});
      case "exec":
        return this.execService(typeof rec.service === "string" ? rec.service : "", asStringArray(rec.command), asStringRecord(rec.client_env) ?? {}, rec.print_env === true);
      case "auth_refresh":
        // Not tokens.invalidate() — that clears the whole store (every
        // identity and audience, including ones this refresh never
        // touches, like a route's IAP-specific credential). probeServiceAccount
        // already forces a fresh mint per identity via tokens.refresh();
        // wiping the store first only destroyed unrelated credentials that
        // nothing here was going to re-mint, so the Credentials screen went
        // from several entries to whatever this one refresh happened to
        // touch.
        await this.commands.refreshIdentity.execute();
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
      case "logs_page":
        return this.queryLogsPage({
          services: asStringArray(rec.services),
          level: typeof rec.level === "string" ? rec.level : "",
          search: typeof rec.search === "string" ? rec.search : "",
          regex: rec.regex === true,
          source: typeof rec.source === "string" ? rec.source : "",
          since: typeof rec.since === "string" ? rec.since : "",
          until: typeof rec.until === "string" ? rec.until : "",
          cursor: typeof rec.cursor === "string" ? rec.cursor : undefined,
          direction: rec.direction === "forward" ? "forward" : "backward",
          limit: typeof rec.limit === "number" ? rec.limit : undefined,
        });
      case "logs_stats":
        return this.queryLogsFacets({
          services: asStringArray(rec.services),
          level: typeof rec.level === "string" ? rec.level : "",
          search: typeof rec.search === "string" ? rec.search : "",
          regex: rec.regex === true,
          source: typeof rec.source === "string" ? rec.source : "",
          since: typeof rec.since === "string" ? rec.since : "",
          until: typeof rec.until === "string" ? rec.until : "",
        });
      case "proxy_start":
        // Only an explicit proxy_start clears suppression — startProxy()
        // itself is also called from start() and reload(), which must not
        // have this side effect.
        this.proxySuppressed = false;
        await this.commands.startProxy.execute();
        return null;
      case "proxy_stop":
        this.proxySuppressed = true;
        await this.commands.stopProxy.execute();
        return null;
      case "mcp_start": {
        // A caller that names a port explicitly wins outright; otherwise
        // fall back to the user's saved preference, the same as daemon boot
        // does above — not straight past it to the bare derived default,
        // which would silently forget a previously chosen port whenever a
        // client starts MCP on demand instead of at boot.
        const explicitPort = typeof rec.port === "number" ? rec.port : undefined;
        await this.startMcp(explicitPort ?? loadTuiConfig(this.cfg.repoRoot).mcp_port);
        return null;
      }
      case "mcp_stop":
        await this.stopMcp();
        return null;
      case "mcp_set_tools": {
        // The client sends the whole deny-list, not a delta: it already
        // renders the full set, and a delta would need conflict rules for two
        // clients toggling at once for no benefit.
        const names = Array.isArray(rec.disabled) ? rec.disabled.filter((n): n is string => typeof n === "string") : [];
        this.setMcpDisabledTools(names);
        return { disabled_tools: [...this.mcpDisabledTools] };
      }
      case "reload":
        return this.commands.reloadConfig.execute();
      case "config_snapshot":
        // Local RPC only — never exposed through MCP. Returns the last-
        // known-good in-memory config with real values intact (not
        // redacted): the TUI is the one deciding whether to display them,
        // via the same Detector-based redaction it already applies
        // elsewhere unless the user has explicitly turned on /reveal.
        return this.cfg;
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
    return this.orchestrator.start(req);
  }

  private lifecycleSession(): LifecycleSession {
    const self = this;
    return {
      get cfg() {
        return self.cfg;
      },
      get profile() {
        return self.profile;
      },
      set profile(value: string) {
        self.profile = value;
      },
      get profileEnv() {
        return self.profileEnv;
      },
      set profileEnv(value: Record<string, string>) {
        self.profileEnv = value;
      },
      get detached() {
        return self.detached;
      },
      set detached(value: boolean) {
        self.detached = value;
      },
      get proxySuppressed() {
        return self.proxySuppressed;
      },
      get runtimes() {
        return self.runtimes;
      },
      get ports() {
        return self.ports;
      },
      get clientEnv() {
        return self.clientEnv;
      },
      get serviceProfile() {
        return self.serviceProfile;
      },
      get serviceProfileEnv() {
        return self.serviceProfileEnv;
      },
      healthCheckers: {
        lookup: (type) => {
          const plugin = self.registry?.healthChecks.find((item) => item.name.toLowerCase() === type.toLowerCase());
          return plugin ? { check: async (cfg, ctx) => {
            const result = await plugin.check(cfg, ctx);
            return { ...result, status: result.status as ServiceHealth };
          } } : self.healthCheckers.lookup(type);
        },
      },
      logs: self.logs,
      bus: self.bus,
      processMeta: self.processMeta,
      get containerPrefix() { return `devctl-${repoID(self.cfg.repoRoot)}-`; },
      prepareServiceIdentity: (name, svc) => self.prepareServiceIdentity(name, svc),
      resolveServiceExecution: (name, svc, profile, env, clientEnv, includeProcess) => self.resolveServiceExecution(name, svc, profile, env, clientEnv, includeProcess),
      detectGoogle: (project) => self.detectGoogleFn(project),
      startProxy: () => self.startProxy(),
      fail: (name, err) => self.fail(name, err),
      claimIfAlreadyUp: (name) => self.claimIfAlreadyUp(name),
      assignPendingPorts: (pending) => self.assignPendingPorts(pending),
      setState: (name, state, health, pid, lastError) => self.setState(name, state, health, pid, lastError),
      persistState: () => self.persistState(),
      log: (service, level, message) => self.log(service, level, message),
      releasePorts: (name) => self.releasePorts(name),
      forgetService: (name) => self.forgetService(name),
    };
  }

  private async assignPendingPorts(pending: string[]): Promise<void> {
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

  async runTask(name: string, clientEnv: Record<string, string>): Promise<{ task: string; code: number; stdout: string; stderr: string }> {
    const task = this.cfg.tasks[name];
    if (!task) throw newError(KindGeneral, `unknown task ${name}`);
    if (task.dependencies.length > 0) {
      await this.start({ services: task.dependencies, client_env: clientEnv });
    }
    const serviceCfg: ServiceConfig = { ...emptyService(), command: task.command, shell: task.shell, working_dir: task.working_dir, dependencies: task.dependencies, environment: task.environment };
    const env = await resolveEnvironment(this.cfg.repoRoot, {
      service: `task:${name}`, profile: this.profile, serviceCfg, profileEnv: this.profileEnv,
      assignedPorts: {}, runtime: runtimeForService(`task:${name}`, "127.0.0.1", {}, "", this.cfg.project.name),
      cfg: this.cfg, clientEnv,
      fetchSecret: secretManagerFetcher(async () => (await this.tokens.get("user", "", [])).accessToken),
      pluginSources: this.registry?.environmentSources,
    });
    const workDir = task.working_dir && !isAbsolute(task.working_dir) ? join(this.cfg.repoRoot, task.working_dir) : task.working_dir;
    const result = await this.runTransient(`task:${name}`, task.command, task.shell, workDir, envList(env));
    return { task: name, ...result };
  }

  async execService(service: string, command: string[], clientEnv?: Record<string, string>, printEnv = false): Promise<{ service: string; code: number; stdout: string; stderr: string; environment?: Record<string, string> }> {
    const svc = this.cfg.services[service];
    if (!svc) throw newError(KindServiceNotFound, `unknown service ${service}`);
    const profile = this.serviceProfile.get(service) ?? this.profile;
    const profileEnv = this.serviceProfileEnv.get(service) ?? this.profileEnv;
    const { env, workDir } = await this.resolveServiceExecution(service, svc, profile, profileEnv, clientEnv, !svc.container);
    if (printEnv) return { service, code: 0, stdout: "", stderr: "", environment: env };
    if (command.length === 0) throw newError(KindGeneral, "exec command is required");
    const result = await this.runTransient(`${service}:exec`, { args: command, shell: false }, false, workDir, env);
    return { service, ...result };
  }

  private async resolveServiceExecution(name: string, svc: ServiceConfig, profile: string, profileEnv: Record<string, string>, clientEnv?: Record<string, string>, includeProcess = true): Promise<{ env: Record<string, string>; workDir: string }> {
    const assigned = this.ports.get(name) ?? Object.fromEntries(svc.ports.filter((port) => !port.auto).map((port) => [port.name, port.value]));
    const proxyURL = this.proxy?.isRunning() ? `http://${this.proxy.address()}` : this.cfg.proxy.enabled ? `http://${listenAddress(this.cfg.proxy.listen)}` : "";
    const runtime = runtimeForService(name, "127.0.0.1", assigned, proxyURL, this.cfg.project.name);
    if (!svc.container) {
      runtime.DEVCTL_INTERNAL_TOKEN = this.internalTok;
      if (this.cfg.proxy.token_endpoint.enabled) runtime.DEVCTL_TOKEN_URL = this.boundTokenURL || `http://127.0.0.1:${this.tokenEP?.listenPort() || this.cfg.proxy.token_endpoint.port}/token`;
    }
    const resolved = await resolveEnvironment(this.cfg.repoRoot, {
      service: name, profile, serviceCfg: svc, profileEnv, assignedPorts: assigned, runtime, cfg: this.cfg,
      fetchSecret: secretManagerFetcher(async () => (await this.tokens.get("user", "", [])).accessToken),
      pluginSources: this.registry?.environmentSources, clientEnv, includeProcess,
    });
    const workDir = svc.working_dir && !isAbsolute(svc.working_dir) ? join(this.cfg.repoRoot, svc.working_dir) : svc.working_dir;
    return { env: envList(resolved), workDir };
  }

  private async runTransient(name: string, command: Command, shell: boolean, workDir: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
    if (commandEmpty(command)) return { code: 0, stdout: "", stderr: "" };
    this.log(name, "INFO", `running ${command.args.join(" ")}`);
    const result = await this.procs.runOnce({
      name, args: [...command.args], shell: shell || command.shell, workDir, env,
      graceMs: graceSeconds(this.cfg.shutdown) * 1000,
      onLine: (stream, line) => this.logs.append({ timestamp: this.clock.isoNow(), service: name, source: stream, stream, level: "", message: line, pid: 0 }),
    });
    if (result.code !== 0) throw newError(KindProcessStart, `${name} exited with code ${result.code}`);
    return result;
  }

  private serviceWorkDir(svc: ServiceConfig): string {
    if (svc.working_dir !== "" && !isAbsolute(svc.working_dir)) {
      return join(this.cfg.repoRoot, svc.working_dir);
    }
    return svc.working_dir;
  }

  private async claimIfAlreadyUp(name: string): Promise<boolean> {
    return claimAdoptedService(this.toHost<RecoverHost>(), name);
  }

  private async recoverSession(): Promise<void> {
    return recoverPersistedSession(this.toHost<RecoverHost>());
  }

  private async prepareServiceIdentity(name: string, svc: ServiceConfig): Promise<void> {
    let ident = fromConfig(svc.identity);
    if (ident.kind !== "none") {
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
        if (requiresCloudCapability(svc) || ident.kind === "service_account" || (ident.kind !== "user" && ident.kind !== "none")) {
          await this.fail(name, err);
          throw err;
        }
        this.log(name, "WARN", "cloud identity unavailable; starting service locally");
      }
    }
  }

  // stop x also stops everything that (transitively) depends on x, never
  // x's own dependencies — see shutdownPlan. Empty names stops every
  // currently-active service but leaves the daemon itself running.
  async stop(names: string[]): Promise<void> {
    return this.orchestrator.stop(names);
  }

  // Drops every trace of a service that no longer has a configuration
  // entry and isn't running — called both when a reload removes an
  // already-stopped service and after an orphaned one is explicitly
  // stopped. Safe to call on a service that was never tracked at all.
  private forgetService(name: string): void {
    this.orchestrator.health.forget(name);
    this.runtimes.delete(name);
    this.ports.delete(name);
    this.processMeta.delete(name);
    this.clientEnv.delete(name);
    this.serviceProfile.delete(name);
    this.serviceProfileEnv.delete(name);
  }

  async restart(names: string[], opts?: { cascade?: boolean; clientEnv?: Record<string, string>; auto?: boolean }): Promise<void> {
    return this.orchestrator.restart(names, opts);
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
    this.mcp = this.createMcpListener({
      port: resolved,
      token: this.mcpToken,
      hostApi: this.asMcpHost(),
      onEvent: (level, message) => this.log("mcp", level, `mcp ${message}`),
      disabledTools: () => this.mcpDisabledTools,
    });
    await this.mcp.start();
    this.persistState();
  }

  // Unknown names are dropped rather than stored: a stale name from an older
  // version would otherwise sit in the list forever, disabling nothing and
  // showing up in status as a tool that does not exist.
  setMcpDisabledTools(names: readonly string[]): void {
    const known = names.filter((name) => this.isKnownTool(name));
    const before = this.mcpDisabledTools.join(",");
    this.mcpDisabledTools = [...new Set(known)].sort();
    // Only when it actually changes, and never the boring "nothing is
    // disabled" case at boot: this runs on every daemon start, and an
    // unconditional line here is pure noise in every session's log.
    if (this.mcpDisabledTools.join(",") === before) {
      return;
    }
    this.log("devctl", "INFO", this.mcpDisabledTools.length === 0
      ? "all MCP tools enabled"
      : `MCP tools disabled: ${this.mcpDisabledTools.join(", ")}`);
  }

  async stopMcp(): Promise<void> {
    await this.mcp?.stop();
    this.mcp = undefined;
    this.persistState();
  }

  private asMcpHost(): McpHost {
    return {
      status: () => this.commands.getServiceStatus.execute(),
      logsPage: (req) => this.queryLogsPage(req),
      config: () => this.cfg,
      validateConfigText: (text) => validateConfigText(this.cfg.repoRoot, this.cfg.configPath, text),
      start: (req) => this.commands.startService.execute(req),
      stop: (names) => this.commands.stopService.execute(names),
      restart: (names, cascade) => this.commands.restartService.execute(names, { cascade }),
      reload: () => this.commands.reloadConfig.execute(),
      doctor: async () => {
        // Explicit doctor inspection is one of the three things allowed to
        // actually probe service accounts (the others: first use, an
        // explicit auth_refresh) — never the automatic boot/reload refresh.
        for (const email of configuredServiceAccounts(this.cfg)) {
          await this.probeServiceAccount(email);
        }
        return this.commands.runDoctor.execute(this.cfg);
      },
      exec: (service, command, printEnv) => this.execService(service, command, undefined, printEnv),
    };
  }

  async reload(): Promise<ReloadResult> {
    return reloadSupervisor(this.toHost<ReloadHost>());
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
    this.orchestrator.health.dispose();
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
    return buildSnapshot(this.toHost<SnapshotHost>());
  }

  // Cheap local read of the credential store (keychain/file) — reflects
  // whatever TokenManager already minted and cached, never triggers a new
  // network fetch itself. Safe to call every time a token actually
  // refreshes, not just on the boot/reload/manual-refresh schedule below.
  private async syncCredentialEntries(): Promise<void> {
    this.credentialEntries = (await this.tokens.listStatus()).map((entry) => ({
      identity: entry.identity,
      audience: entry.audience,
      expires_at: entry.expires_at,
      valid: entry.valid,
    }));
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
      const { service_accounts, service_account_status } = serviceAccountSnapshot(this.cfg, this.serviceAccountStatus);
      this.identityCache = {
        user: st.userEmail,
        project: st.projectID || this.cfg.google.project_id,
        project_source: st.projectSource || (this.cfg.google.project_id ? "configuration" : ""),
        adc: st.adcAvailable,
        service_accounts,
        service_account_status,
        iap: this.cfg.proxy.routes.some((route) => route.auth.type.toLowerCase() === "iap"),
      };
      await this.syncCredentialEntries();
      this.bus.publish(newEvent(AuthenticationChanged, "", { user: this.identityCache.user, adc: this.identityCache.adc }));
      this.log("auth", "INFO", `authentication changed user=${this.identityCache.user || "(unknown)"} adc=${this.identityCache.adc}`);
      this.persistState();
    } catch (err) {
      this.log("devctl", "WARN", `identity refresh failed: ${humanMessage(err)}`);
    }
  }

  // Always mints fresh (never serves a cached-still-valid token) — this is
  // an explicit "confirm impersonation actually works right now" check
  // (auth_refresh or doctor), not a routine fetch, so a token that's merely
  // unexpired isn't good enough evidence. tokens.refresh() achieves that by
  // overwriting just this one cache entry; the caller must never reach for
  // tokens.invalidate() to force the same thing — that clears every
  // credential in the store, including ones this probe never touches.
  private async probeServiceAccount(email: string): Promise<ServiceAccountStatus> {
    let status: ServiceAccountStatus;
    try {
      await withTimeout(this.tokens.refresh(`sa:${email}`, "", []), IDENTITY_PROBE_MS);
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

  // Bounded, cursor-paged counterpart to queryLogs() — added alongside it
  // rather than replacing it so CLI/TUI/MCP consumers can migrate to paging
  // one at a time; queryLogs()/the plain "logs" RPC still returns everything
  // matching, unbounded, until every consumer has moved off it.
  queryLogsPage(req: LogFilter & LogPageRequest): LogPage {
    return this.logs.queryPage(
      {
        services: req.services,
        level: req.level,
        search: req.search,
        regex: req.regex,
        source: req.source,
        since: req.since,
        until: req.until,
      },
      { cursor: req.cursor, direction: req.direction, limit: req.limit },
    );
  }

  queryLogsFacets(req: LogFilter): LogFacets {
    return this.logs.queryFacets({
      services: req.services,
      level: req.level,
      search: req.search,
      regex: req.regex,
      source: req.source,
      since: req.since,
      until: req.until,
    });
  }

  subscribe(handler: (event: import("../../shared/events.ts").BusEvent) => void): () => void {
    return this.bus.subscribe(handler);
  }

  formatStatus(): string {
    return formatStatusFromSnapshot(this.snapshot());
  }

  private setState(name: string, state: ServiceState, health: ServiceHealth, pid: number, lastError: string): void {
    const rt = this.runtimes.get(name) ?? emptyRuntime(name);
    if (!canTransition(rt.state, state)) {
      this.log(name, "WARN", `unusual lifecycle ${rt.state} → ${state}`);
    }
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

  private async releasePorts(name: string): Promise<void> {
    const ports = this.ports.get(name);
    if (!ports) {
      return;
    }
    const svc = this.cfg.services[name];
    if (svc?.container) {
      // The runtime owns the host-side publishing proxy; stopping the
      // container releases it. PID identity checks apply only to host services.
      this.ports.delete(name);
      return;
    }
    const meta = this.processMeta.get(name);
    for (const port of Object.values(ports)) {
      const holder = await findPortHolder(port);
      if (!holder || holder.pid === process.pid) {
        continue;
      }
      if (svc) {
        const observed = await this.inspectProcessFn(holder.pid);
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
    this.orchestrator.health.clearHealthWatch(name);
    this.orchestrator.health.clearRestartTimer(name);
    this.orchestrator.health.bumpGeneration(name);
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
      timestamp: this.clock.isoNow(),
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
}

export function diffReload(prev: DevctlConfig, next: DevctlConfig): ReloadResult {
  return configSnapshotDiff(prev, next);
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

export { formatPlan };
