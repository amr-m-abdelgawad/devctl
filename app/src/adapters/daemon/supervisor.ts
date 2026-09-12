import type { FSWatcher } from "node:fs";
import {
  type DevctlConfig,
  type ServiceConfig,
  type Command,
  emptyService,
  commandEmpty,
  graceSeconds,
  validateConfigText,
  stopOnExit,
} from "../config/index.ts";
import { claimIfAlreadyUp as claimAdoptedService, recoverSession as recoverPersistedSession, type RecoverHost } from "./recover.ts";
import { applyRegistry as applyPluginRegistry, checkPluginEnvironmentSources as assertPluginEnvironmentSources, checkPluginHealthTypes as assertPluginHealthTypes, checkPluginIdentityTypes as assertPluginIdentityTypes, pluginMtimes, reloadSupervisor, watchConfig as watchConfigDir, type ReloadHost } from "./reload.ts";
import { ServiceWatchers } from "./service-watch.ts";
import { EnvironmentBridge } from "./environment-bridge.ts";
import { IdentityCoordinator } from "./identity-coordinator.ts";
import { McpCoordinator } from "./mcp-coordinator.ts";
import { ProxyCoordinator } from "./proxy-coordinator.ts";
import { ResourceSampler } from "./resource-sampler.ts";
import { buildSnapshot, formatStatusFromSnapshot, type SnapshotHost } from "./snapshot.ts";
import { asLogFilter, asStringArray, asStringRecord, isRecord } from "../rpc/params.ts";
import { RpcServer } from "../rpc/server.ts";
import type { LifecycleSession } from "../../ports/lifecycle-session.ts";
import type { DaemonCommandHost, DaemonCommands, ServiceOrchestratorPort } from "../../ports/daemon.ts";
import type { McpHost, McpListenerFactory } from "../../ports/mcp-host.ts";
import { configSnapshotDiff } from "../../domain/config/snapshot.ts";
import { canTransition } from "../../domain/service/lifecycle.ts";
import type { Clock } from "../../ports/clock.ts";
import type { FileSystem } from "../../ports/filesystem.ts";
import { DevctlError, KindGeneral, KindProcessStart, KindServiceNotFound, humanMessage, newError } from "../../shared/errors.ts";
import {
  type Bus,
  ServiceFailed,
  ServiceStateChanged,
  newEvent,
} from "../../shared/events.ts";
import { type GoogleStatus } from "../google/google.ts";
import type { HealthCheckerFactory } from "../../ports/health-checker.ts";
import { configuredServiceAccounts } from "../../domain/identity/identity.ts";
import type { LogStore } from "../../ports/log-store.ts";
import type { SpanStore } from "../../ports/span-store.ts";
import type { LogEvent, LogFacets, LogFilter, LogPage, LogPageRequest } from "../../domain/logs/logs.ts";
import { isTraceId } from "../../domain/logs/ids.ts";
import { assignPorts, findPortHolder, freePort } from "../net/ports.ts";
import { loadPluginPaths, type Registry } from "../plugins/registry.ts";
import { type ProcessManager, sameProcess, type ProcessIdentity } from "../process/processes.ts";
import { loadTuiConfig } from "../config/tui-preferences.ts";
import { Detector } from "../secrets/detector.ts";
import {
  HealthUnknown,
  StateFailed,
  StateHealthy,
  StateUnhealthy,
  StateRunning,
  dependentsClosure,
  emptyRuntime,
  profileEnvironment,
  type Plan,
  type Runtime,
  type ServiceHealth,
  type ServiceState,
} from "../../domain/service/services.ts";
import { randomSecret, repoID, socketPath, writePersistedState } from "../storage/storage.ts";
import { SpanManager } from "../storage/spans.ts";
import { TelemetryCoordinator } from "./telemetry-coordinator.ts";
import type { TokenManager } from "../google/token.ts";
import type { LogsRequest, ReloadResult, StartRequest, StatusSnapshot, TraceResponse } from "../../domain/status.ts";
import { RPC_PROTOCOL_VERSION, VERSION } from "../../version.ts";

export class Supervisor {
  private cfg: DevctlConfig;
  private readonly sessionID: string;
  private readonly internalTok: string;
  private readonly bus: Bus;
  private readonly logs: LogStore;
  private readonly spans: SpanStore;
  private readonly procs: ProcessManager;
  private readonly tokens: TokenManager;
  private readonly detector: Detector;
  private readonly env: EnvironmentBridge;
  private readonly proxy: ProxyCoordinator;
  private readonly telemetry: TelemetryCoordinator;
  private readonly mcp: McpCoordinator;
  private readonly resources: ResourceSampler;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly ports = new Map<string, Record<string, number>>();
  private lock?: { release: () => void };
  private shuttingDown = false;
  private detached = false;
  private readonly identity: IdentityCoordinator;
  private readonly rpc: RpcServer;
  private readonly detectGoogleFn: (project: string) => Promise<GoogleStatus>;
  private readonly inspectProcessFn: (pid: number) => Promise<ProcessIdentity | undefined>;
  private readonly processAliveFn: (pid: number) => boolean;
  private readonly acquireLockFn: (repoRoot: string, socket: string) => { release: () => void };
  private readonly socketExistsFn: (socket: string) => boolean;
  private readonly unlinkSocketFn: (socket: string) => void;
  private registry?: Registry;
  private restartRequired: string[] = [];
  private readonly processMeta = new Map<string, { command: string[]; cwd: string; startTime: Date }>();
  private configWatcher?: FSWatcher;
  private watchTimer?: ReturnType<typeof setTimeout>;
  // No configuration on disk yet — see StatusSnapshot.setup_mode. Cleared by
  // the first reload that successfully loads one.
  private setupMode: boolean;
  private readonly serviceWatchers: ServiceWatchers;
  private pluginMtimes = new Map<string, number>();

  private readonly orchestrator: ServiceOrchestratorPort;
  private readonly commands: DaemonCommands;
  private readonly clock: Clock;
  private readonly fs: FileSystem;
  private readonly healthCheckers: HealthCheckerFactory;

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
    this.spans = new SpanManager(undefined, this.detector);
    this.procs = deps.procs;
    this.orchestrator = deps.orchestrator;
    this.tokens = deps.tokens;
    this.telemetry = new TelemetryCoordinator({
      cfg: () => this.cfg,
      logs: this.logs,
      spans: this.spans,
      log: (service, level, message) => this.log(service, level, message),
    });
    this.proxy = new ProxyCoordinator({
      cfg: () => this.cfg,
      ports: () => this.ports,
      tokens: this.tokens,
      logs: this.logs,
      spans: this.spans,
      bus: this.bus,
      detector: this.detector,
      internalTok: () => this.internalTok,
      middleware: () => this.registry?.proxyMiddleware ?? [],
      persistState: () => this.persistState(),
    });
    this.env = new EnvironmentBridge({
      cfg: () => this.cfg,
      ports: () => this.ports,
      userEmail: () => this.identity.identityCache.user,
      proxy: () => this.proxy.instance,
      tokenEndpoint: () => this.proxy.tokenEndpoint,
      boundTokenURL: () => this.proxy.boundTokenURL,
      internalTok: () => this.internalTok,
      tokens: this.tokens,
      environmentSources: () => this.registry?.environmentSources,
      otlpEndpoint: () => this.telemetry.endpoint(),
    });
    this.mcp = new McpCoordinator({
      repoRoot: () => this.cfg.repoRoot,
      createListener: deps.createMcpListener,
      hostApi: () => this.asMcpHost(),
      isKnownTool: deps.isKnownTool,
      log: (service, level, message) => this.log(service, level, message),
      persistState: () => this.persistState(),
    });
    this.resources = new ResourceSampler({
      clock: this.clock,
      runtimes: () => this.runtimes,
    });
    this.identity = new IdentityCoordinator({
      cfg: () => this.cfg,
      tokens: this.tokens,
      detectGoogle: (project) => this.detectGoogleFn(project),
      clock: this.clock,
      bus: this.bus,
      logs: this.logs,
      persistState: () => this.persistState(),
      fail: (name, err) => this.fail(name, err),
      log: (service, level, message) => this.log(service, level, message),
      identityProviders: () => this.registry?.identityProviders,
    });
    this.rpc = new RpcServer({
      dispatch: (method, params) => this.dispatch(method, params),
      subscribe: (handler, types) => this.bus.subscribe(handler, types),
      log: (service, level, message) => this.log(service, level, message),
      socketExists: (socket) => this.socketExistsFn(socket),
      unlinkSocket: (socket) => this.unlinkSocketFn(socket),
    });
    this.setupMode = !this.fs.exists(cfg.configPath);
    for (const name of Object.keys(cfg.services)) {
      this.runtimes.set(name, emptyRuntime(name));
    }
    this.orchestrator.bind(this.lifecycleSession());
    this.commands = deps.createCommands(this);
    this.serviceWatchers = new ServiceWatchers({
      repoRoot: () => this.cfg.repoRoot,
      log: (service, level, message) => this.log(service, level, message),
      isActive: (name) => this.orchestrator.serviceIsActive(name),
      restart: (name) => this.restart([name], { auto: true }),
    });
  }

  // Tests and recover/reload hosts poke these at runtime.
  private get profile(): string { return this.env.profile; }
  private set profile(value: string) { this.env.profile = value; }
  private get profileEnv(): Record<string, string> { return this.env.profileEnv; }
  private set profileEnv(value: Record<string, string>) { this.env.profileEnv = value; }
  private get clientEnv(): Map<string, Record<string, string>> { return this.env.clientEnv; }
  private get serviceProfile(): Map<string, string> { return this.env.serviceProfile; }
  private get serviceProfileEnv(): Map<string, Record<string, string>> { return this.env.serviceProfileEnv; }

  private snapshotHost(): SnapshotHost {
    const self = this;
    return {
      get sessionID() { return self.sessionID; },
      get cfg() { return self.cfg; },
      get profile() { return self.profile; },
      get runtimes() { return self.runtimes; },
      get ports() { return self.ports; },
      get serviceProfile() { return self.serviceProfile; },
      get clientEnv() { return self.clientEnv; },
      get proxy() { return self.proxy.instance; },
      get mcp() { return self.mcp.instance; },
      get mcpToken() { return self.mcp.token; },
      get mcpDisabledTools() { return self.mcp.disabledTools; },
      get identityCache() { return self.identity.identityCache; },
      get serviceAccountStatus() { return self.identity.serviceAccountStatus; },
      get credentialEntries() { return self.identity.credentialEntries; },
      get detached() { return self.detached; },
      get setupMode() { return self.setupMode; },
      get restartRequired() { return self.restartRequired; },
      get statsSeries() {
        return self.resources.series();
      },
      logs: { snapshot: () => self.logs.snapshot() },
      tokens: { storeBackend: () => self.tokens.storeBackend() },
    };
  }

  private reloadHost(): ReloadHost {
    const self = this;
    return {
      get cfg() { return self.cfg; },
      set cfg(value) { self.cfg = value; },
      get setupMode() { return self.setupMode; },
      set setupMode(value) { self.setupMode = value; },
      get configWatcher() { return self.configWatcher; },
      set configWatcher(value) { self.configWatcher = value; },
      get watchTimer() { return self.watchTimer; },
      set watchTimer(value) { self.watchTimer = value; },
      get restartRequired() { return self.restartRequired; },
      set restartRequired(value) { self.restartRequired = value; },
      get fs() { return self.fs; },
      get registry() { return self.registry; },
      set registry(value) { self.registry = value; },
      get pluginMtimes() { return self.pluginMtimes; },
      set pluginMtimes(value) { self.pluginMtimes = value; },
      get detector() { return self.detector; },
      get bus() { return self.bus; },
      get orchestrator() { return self.orchestrator; },
      get runtimes() { return self.runtimes; },
      get tokens() { return self.tokens; },
      get logs() { return self.logs; },
      get proxy() { return self.proxy.instance; },
      persistState: () => self.persistState(),
      log: (service, level, message) => self.log(service, level, message),
      refreshIdentity: () => self.refreshIdentity(),
      startProxy: () => self.startProxy(),
      stopProxy: () => self.stopProxy(),
      reload: () => self.reload(),
      forgetService: (name) => self.forgetService(name),
      syncServiceWatchers: () => self.serviceWatchers.sync(self.cfg.services),
    };
  }

  private recoverHost(): RecoverHost {
    const self = this;
    return {
      get cfg() { return self.cfg; },
      set cfg(value) { self.cfg = value; },
      get profile() { return self.profile; },
      set profile(value) { self.profile = value; },
      get profileEnv() { return self.profileEnv; },
      set profileEnv(value) { self.profileEnv = value; },
      get runtimes() { return self.runtimes; },
      get ports() { return self.ports; },
      get processMeta() { return self.processMeta; },
      get serviceProfile() { return self.serviceProfile; },
      get serviceProfileEnv() { return self.serviceProfileEnv; },
      get orchestrator() { return self.orchestrator; },
      get procs() { return self.procs; },
      logs: { append: (event) => self.logs.append(event) },
      get clock() { return self.clock; },
      get tokens() { return self.tokens; },
      get registry() { return self.registry; },
      get proxy() { return self.proxy.instance; },
      get tokenEP() { return self.proxy.tokenEndpoint; },
      get boundTokenURL() { return self.proxy.boundTokenURL; },
      get internalTok() { return self.internalTok; },
      get bus() { return self.bus; },
      inspectProcessFn: (pid) => self.inspectProcessFn(pid),
      processAliveFn: (pid) => self.processAliveFn(pid),
      serviceWorkDir: (svc) => self.serviceWorkDir(svc),
      persistState: () => self.persistState(),
      setState: (name, state, health, pid, lastError) => self.setState(name, state, health, pid, lastError),
      log: (service, level, message) => self.log(service, level, message),
    };
  }

  async run(): Promise<void> {
    const socket = socketPath(this.cfg.repoRoot);
    // Acquire the lock BEFORE touching the socket file. acquireLock() is what
    // proves no live supervisor already owns this repo; deleting the socket
    // first (the old order) let a losing second process unlink a *live*
    // peer's bound socket before discovering — via the lock — that it had
    // lost the race, leaving the winner still running but unreachable.
    this.lock = this.acquireLockFn(this.cfg.repoRoot, socket);
    this.rpc.removeStaleSocket(socket);
    this.registry = await loadPluginPaths(this.cfg.plugins.map((plugin) => plugin.path), this.cfg.repoRoot);
    this.pluginMtimes = pluginMtimes(this.cfg.plugins.map((plugin) => plugin.path), this.cfg.repoRoot);
    for (const failure of this.registry.loadErrors) this.log("devctl", "ERROR", `plugin ${failure.path} skipped: ${failure.message}`);
    applyPluginRegistry(this.reloadHost());
    assertPluginHealthTypes(this.registry, this.cfg);
    assertPluginIdentityTypes(this.registry, this.cfg);
    assertPluginEnvironmentSources(this.registry, this.cfg);
    await this.recoverSession();
    this.serviceWatchers.sync(this.cfg.services);
    watchConfigDir(this.reloadHost());
    this.persistState();
    this.log("devctl", "INFO", `supervisor started session=${this.sessionID}`);
    void this.refreshIdentity();
    this.resources.start();
    await this.telemetry.start();
    await this.mcp.bootFromPreferences();
    // Lazy, sticky proxy policy: startup never binds it. The first start()
    // call auto-starts it (see start() below) unless the user has
    // explicitly suppressed it with `proxy stop`.
    // Recheck immediately before binding: still holding the lock acquired
    // above, so anything now at this path is necessarily stale (nothing else
    // can have won the lock in the meantime) — but the plugin/session work
    // above this point had await points, so re-verify rather than trust the
    // check from before them.
    this.rpc.removeStaleSocket(socket);
    await this.rpc.listen(socket);
  }

  async dispatch(method: string, params: unknown): Promise<unknown> {
    const rec = isRecord(params) ? params : {};
    switch (method) {
      case "ping":
        return { session: this.sessionID, version: VERSION, protocol: RPC_PROTOCOL_VERSION };
      case "start":
        return this.commands.startService.execute({
          services: asStringArray(rec.services),
          profile: typeof rec.profile === "string" && rec.profile !== "" ? rec.profile : undefined,
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
        return await this.queryLogs({
          ...asLogFilter(rec),
          export: typeof rec.export === "string" ? rec.export : "",
        });
      case "logs_page":
        return await this.queryLogsPage({
          ...asLogFilter(rec),
          cursor: typeof rec.cursor === "string" ? rec.cursor : undefined,
          direction: rec.direction === "forward" ? "forward" : "backward",
          limit: typeof rec.limit === "number" ? rec.limit : undefined,
        });
      case "logs_stats":
        return await this.queryLogsFacets(asLogFilter(rec));
      case "get_trace":
        return await this.queryTrace(typeof rec.trace_id === "string" ? rec.trace_id : typeof rec.traceId === "string" ? rec.traceId : "");
      case "trace_request":
        return await this.queryTraceByRequest(typeof rec.request_id === "string" ? rec.request_id : typeof rec.requestId === "string" ? rec.requestId : "");
      case "proxy_start":
        // Only an explicit proxy_start clears suppression — startProxy()
        // itself is also called from start() and reload(), which must not
        // have this side effect.
        this.proxy.setSuppressed(false);
        await this.commands.startProxy.execute();
        return null;
      case "proxy_stop":
        this.proxy.setSuppressed(true);
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
        return { disabled_tools: [...this.mcp.disabledTools] };
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
        return self.proxy.isSuppressed;
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
      logs: { append: (event) => self.logs.append(event) },
      bus: self.bus,
      processMeta: self.processMeta,
      get containerPrefix() { return `devctl-${repoID(self.cfg.repoRoot)}-`; },
      prepareServiceIdentity: (name, svc) => self.identity.prepareServiceIdentity(name, svc),
      resolveServiceExecution: (name, svc, profile, env, clientEnv, includeProcess) => self.env.resolveServiceExecution(name, svc, profile, env, clientEnv, includeProcess),
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
      clearRestartRequired: (names) => self.dropRestartRequired(names),
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
    const { env, workDir } = await this.env.resolveTaskEnvironment(name, serviceCfg, clientEnv);
    const result = await this.runTransient(`task:${name}`, task.command, task.shell, workDir, env);
    return { task: name, ...result };
  }

  async execService(service: string, command: string[], clientEnv?: Record<string, string>, printEnv = false): Promise<{ service: string; code: number; stdout: string; stderr: string; environment?: Record<string, string> }> {
    const svc = this.cfg.services[service];
    if (!svc) throw newError(KindServiceNotFound, `unknown service ${service}`);
    const profile = this.env.serviceProfile.get(service) ?? this.env.profile;
    const profileEnv = profile !== "" ? profileEnvironment(this.cfg, profile) : this.env.profileEnv;
    const { env, workDir } = await this.env.resolveServiceExecution(service, svc, profile, profileEnv, clientEnv, !svc.container);
    if (printEnv) return { service, code: 0, stdout: "", stderr: "", environment: env };
    if (command.length === 0) throw newError(KindGeneral, "exec command is required");
    const result = await this.runTransient(`${service}:exec`, { args: command, shell: false }, false, workDir, env);
    return { service, ...result };
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
    return this.env.serviceWorkDir(svc);
  }

  private async claimIfAlreadyUp(name: string): Promise<boolean> {
    return claimAdoptedService(this.recoverHost(), name);
  }

  private async recoverSession(): Promise<void> {
    return recoverPersistedSession(this.recoverHost());
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
    this.env.forget(name);
  }

  async restart(names: string[], opts?: { cascade?: boolean; clientEnv?: Record<string, string>; auto?: boolean }): Promise<void> {
    const targets = opts?.cascade === true ? dependentsClosure(this.cfg, names) : names;
    await this.orchestrator.restart(names, opts);
    this.dropRestartRequired(targets);
  }

  private dropRestartRequired(names: string[]): void {
    if (names.length === 0) {
      return;
    }
    const drop = new Set(names);
    this.restartRequired = this.restartRequired.filter((name) => !drop.has(name));
  }

  async startProxy(): Promise<void> {
    return this.proxy.start();
  }

  async stopProxy(): Promise<void> {
    return this.proxy.stop();
  }

  async startMcp(port?: number): Promise<void> {
    return this.mcp.start(port);
  }

  setMcpDisabledTools(names: readonly string[]): void {
    this.mcp.setDisabledTools(names);
  }

  async stopMcp(): Promise<void> {
    return this.mcp.stop();
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
          await this.identity.probeServiceAccount(email);
        }
        return this.commands.runDoctor.execute(this.cfg);
      },
      exec: (service, command, printEnv) => this.execService(service, command, undefined, printEnv),
      runTask: (name) => this.runTask(name, {}),
      startProxy: () => this.startProxy(),
      stopProxy: () => this.stopProxy(),
      getTrace: (traceId) => this.queryTrace(traceId),
      traceRequest: (requestId) => this.queryTraceByRequest(requestId),
    };
  }

  async reload(): Promise<ReloadResult> {
    return reloadSupervisor(this.reloadHost());
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
    await this.telemetry.stop();
    this.spans.close();
    await this.stopMcp();
    this.configWatcher?.close();
    this.serviceWatchers.close();
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.resources.stop();
    this.rpc.close();
    this.lock?.release();
    await this.logs.close();
  }

  snapshot(): StatusSnapshot {
    return buildSnapshot(this.snapshotHost());
  }

  async refreshIdentity(opts?: { probeServiceAccounts?: boolean }): Promise<void> {
    return this.identity.refreshIdentity(opts);
  }

  async queryLogs(req: LogsRequest): Promise<{ events: LogEvent[] }> {
    const filter = this.logFilter(req);
    const events = await this.logs.query(filter);
    if (req.export) {
      await this.logs.exportTo(req.export, filter);
    }
    return { events };
  }

  // Bounded, cursor-paged counterpart to queryLogs() — added alongside it
  // rather than replacing it so CLI/TUI/MCP consumers can migrate to paging
  // one at a time; queryLogs()/the plain "logs" RPC still returns everything
  // matching, unbounded, until every consumer has moved off it.
  async queryLogsPage(req: LogFilter & LogPageRequest): Promise<LogPage> {
    return this.logs.queryPage(this.logFilter(req), { cursor: req.cursor, direction: req.direction, limit: req.limit });
  }

  async queryLogsFacets(req: LogFilter): Promise<LogFacets> {
    return this.logs.queryFacets(this.logFilter(req));
  }

  async queryTrace(traceId: string): Promise<TraceResponse> {
    const tree = this.spans.getTrace(traceId);
    const events = traceId === "" ? [] : await this.logs.query({ traceId });
    return { traceId, tree, events };
  }

  async queryTraceByRequest(requestId: string): Promise<TraceResponse> {
    const mapped = this.spans.findTraceIdByRequestId(requestId);
    const traceId = mapped ?? (isTraceId(requestId) ? requestId.toLowerCase() : "");
    const result = await this.queryTrace(traceId);
    return { ...result, requestId };
  }

  private logFilter(req: LogFilter | LogsRequest): LogFilter {
    return {
      services: req.services,
      level: req.level,
      search: req.search,
      regex: req.regex,
      source: req.source,
      since: req.since,
      until: req.until,
      traceId: req.traceId,
      requestId: req.requestId,
      attribute: req.attribute,
    };
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
        profile: this.serviceProfile.get(handle.name) ?? this.profile,
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
