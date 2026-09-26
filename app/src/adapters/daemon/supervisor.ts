import type { FSWatcher } from "node:fs";
import {
  type DevctlConfig,
  type ServiceConfig,
  type Command,
  emptyService,
  commandEmpty,
  graceSeconds,
  inspectCapBytes,
  validateConfigText,
  stopOnExit,
  dependencyName,
} from "../config/index.ts";
import { claimIfAlreadyUp as claimAdoptedService, recoverSession as recoverPersistedSession, type RecoverHost } from "./recover.ts";
import { applyRegistry as applyPluginRegistry, checkPluginEnvironmentSources as assertPluginEnvironmentSources, checkPluginHealthTypes as assertPluginHealthTypes, checkPluginIdentityTypes as assertPluginIdentityTypes, checkPluginInspectDecoders as assertPluginInspectDecoders, checkPluginLlmSourceTypes as assertPluginLlmSourceTypes, pluginMtimes, reloadSupervisor, watchConfig as watchConfigDir, type ReloadHost } from "./reload.ts";
import { ServiceWatchers } from "./service-watch.ts";
import { EnvironmentBridge } from "./environment-bridge.ts";
import { envWithSecrets } from "../environment/environment.ts";
import { resolveHealthConfig } from "../config/refs.ts";
import { IdentityCoordinator } from "./identity-coordinator.ts";
import { McpCoordinator } from "./mcp-coordinator.ts";
import { WebCoordinator } from "./web-coordinator.ts";
import { ProxyCoordinator } from "./proxy-coordinator.ts";
import { ResourceSampler } from "./resource-sampler.ts";
import { buildSnapshot, formatStatusFromSnapshot, type SnapshotHost } from "./snapshot.ts";
import { asLogFilter, asLlmCallFilter, asTrafficCallFilter, asStringArray, asStringRecord, isRecord } from "../rpc/params.ts";
import { RpcServer } from "../rpc/server.ts";
import type { LifecycleSession } from "../../ports/lifecycle-session.ts";
import type { DaemonCommandHost, DaemonCommands, ServiceOrchestratorPort } from "../../ports/daemon.ts";
import type { McpHost, McpListenerFactory } from "../../ports/mcp-host.ts";
import type { WebListenerFactory } from "../../ports/web-host.ts";
import { configSnapshotDiff } from "../../domain/config/snapshot.ts";
import { canTransition } from "../../domain/service/lifecycle.ts";
import { implicitServiceDependencies, recipesNeededForEnv } from "../../domain/http/recipes.ts";
import { effectiveServiceEnv, namedEnvironmentNames, resolveEnvironmentName, serviceHasNamedEnvironments } from "../../domain/service/environments.ts";
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
import { TokenManager } from "../google/token.ts";
import type { HealthCheckerFactory } from "../../ports/health-checker.ts";
import { configuredServiceAccounts } from "../../domain/identity/identity.ts";
import type { LogStore } from "../../ports/log-store.ts";
import type { SpanStore } from "../../ports/span-store.ts";
import type { LlmCallStore } from "../../ports/llm-call-store.ts";
import type { TrafficCallStore } from "../../ports/traffic-call-store.ts";
import type { LlmSourceFactory } from "../../ports/llm-source.ts";
import { dedupeLogsByRequestId, isTraceId, type LogEvent, type LogFacets, type LogFilter, type LogPage, type LogPageRequest } from "../../domain/logs/logs.ts";
import type { LlmCall, LlmCallFilter, LlmCallPage, LlmCallPageRequest } from "../../domain/llm/llm.ts";
import type { TrafficCall, TrafficCallFilter, TrafficCallPage, TrafficCallPageRequest } from "../../domain/traffic/traffic.ts";
import { LlmCallManager } from "../llm/store.ts";
import { TrafficCallRing } from "../traffic/store.ts";
import { LlmCoordinator } from "../llm/coordinator.ts";
import { ProxyCaptureSink } from "../llm/proxy-capture.ts";
import { ProxyTrafficSink } from "../traffic/capture.ts";
import { llmSourceFactory } from "../llm/factory.ts";
import { assignPorts, findPortHolder, freePort } from "../net/ports.ts";
import { loadPluginPaths, type Registry } from "../plugins/registry.ts";
import { type ProcessManager, provenSameProcess, type ProcessIdentity } from "../process/processes.ts";
import { callerServiceForPeer } from "../process/peer-caller.ts";
import { getPreferenceSnapshot, loadTuiConfig, resetTuiPreferences, saveTuiPreferences } from "../config/tui-preferences.ts";
import { hasLocalConfigPatch, patchRepoLocalConfig } from "../config/local-overlay.ts";
import { isPreferenceScope, type PreferenceScope, type PreferenceWrite, type TuiPreferencePatch } from "../../domain/ui/preferences.ts";
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
import { listSessions, loadSessionEvents } from "../storage/logs.ts";
import { logsDir, persistedConfigOverlay, randomSecret, readOrCreateRpcToken, repoID, socketPath, writePersistedState } from "../storage/storage.ts";
import { SpanManager } from "../storage/spans.ts";
import { TelemetryCoordinator } from "./telemetry-coordinator.ts";
import { RecipeRuntime } from "../http/runtime.ts";
import type { HttpRecipeRuntime } from "../../ports/http-recipe-runtime.ts";
import type { LogsRequest, ReloadResult, StartRequest, StatusSnapshot, TraceResponse } from "../../domain/status.ts";
import { RPC_PROTOCOL_VERSION, VERSION } from "../../version.ts";

/** Outcome of Supervisor.shutdown(): whether services were stopped, and the teardown error if any. */
export type SupervisorStopped = { servicesStopped: boolean; failure?: unknown };

export class Supervisor {
  private cfg: DevctlConfig;
  private readonly sessionID: string;
  private readonly internalTok: string;
  private readonly bus: Bus;
  private readonly logs: LogStore;
  private readonly spans: SpanStore;
  private readonly llmStore: LlmCallStore;
  private readonly trafficStore: TrafficCallStore;
  private llmFactory: LlmSourceFactory;
  private readonly llm: LlmCoordinator;
  private readonly llmCapture: ProxyCaptureSink;
  private readonly trafficCapture: ProxyTrafficSink;
  private readonly procs: ProcessManager;
  private readonly tokens: TokenManager;
  private readonly recipes: HttpRecipeRuntime;
  private readonly detector: Detector;
  private readonly env: EnvironmentBridge;
  private readonly proxy: ProxyCoordinator;
  private readonly telemetry: TelemetryCoordinator;
  private readonly mcp: McpCoordinator;
  private readonly web: WebCoordinator;
  private readonly resources: ResourceSampler;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly ports = new Map<string, Record<string, number>>();
  private lock?: { release: () => void };
  private shuttingDown = false;
  private markStopped: (result: SupervisorStopped) => void = () => undefined;
  /** Resolves once shutdown() has finished, with the teardown error if one step threw. */
  readonly stopped: Promise<SupervisorStopped> = new Promise((resolve) => {
    this.markStopped = resolve;
  });
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
  private configOverlay?: string;
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
      createWebListener: WebListenerFactory;
      isKnownTool: (name: string) => boolean;
      createCommands: (host: DaemonCommandHost) => DaemonCommands;
    },
  ) {
    this.healthCheckers = deps.healthCheckers;
    this.cfg = cfg;
    this.configOverlay = persistedConfigOverlay(cfg.repoRoot);
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
    this.llmStore = new LlmCallManager(this.detector);
    this.trafficStore = new TrafficCallRing(this.detector);
    this.llmFactory = llmSourceFactory([]);
    this.llmCapture = new ProxyCaptureSink({
      cfg: () => this.cfg,
      store: this.llmStore,
      log: (message) => this.log("devctl", "WARN", message),
      lookupCaller: (peer) => callerServiceForPeer(peer, () => this.procs.all()),
    });
    this.trafficCapture = new ProxyTrafficSink({
      cfg: () => this.cfg,
      store: this.trafficStore,
      log: (message) => this.log("devctl", "WARN", message),
      lookupCaller: (peer) => callerServiceForPeer(peer, () => this.procs.all()),
      decoders: () => this.registry?.trafficDecoders ?? [],
    });
    this.procs = deps.procs;
    this.orchestrator = deps.orchestrator;
    this.tokens = deps.tokens;
    this.recipes = new RecipeRuntime({
      cfg: () => this.cfg,
      tokens: this.tokens,
      clock: this.clock,
      userEmail: () => this.identity.identityCache.user,
      ports: () => this.ports,
      processEnv: () => envWithSecrets(process.env, this.cfg.repoRoot),
      log: (message) => this.log("devctl", "INFO", message),
    });
    this.llm = new LlmCoordinator({
      cfg: () => this.cfg,
      store: this.llmStore,
      factory: () => this.llmFactory,
      ports: () => this.ports,
      log: (service, level, message) => this.log(service, level, message),
      tokens: this.tokens,
    });
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
      recipes: this.recipes,
      logs: this.logs,
      spans: this.spans,
      bus: this.bus,
      detector: this.detector,
      internalTok: () => this.internalTok,
      middleware: () => this.registry?.proxyMiddleware ?? [],
      capture: this.llmCapture,
      traffic: this.trafficCapture,
      persistState: () => this.persistState(),
    });
    this.env = new EnvironmentBridge({
      cfg: () => this.cfg,
      ports: () => this.ports,
      userEmail: () => this.identity.identityCache.user,
      proxy: () => this.proxy.instance,
      boundTokenURL: () => this.proxy.boundTokenURL,
      internalTok: () => this.internalTok,
      tokens: this.tokens,
      recipes: this.recipes,
      environmentSources: () => this.registry?.environmentSources,
      otlpEndpoint: () => this.telemetry.endpoint(),
      log: (level, message) => this.log("devctl", level, message),
    });
    this.mcp = new McpCoordinator({
      repoRoot: () => this.cfg.repoRoot,
      createListener: deps.createMcpListener,
      hostApi: () => this.asMcpHost(),
      isKnownTool: deps.isKnownTool,
      log: (service, level, message) => this.log(service, level, message),
      persistState: () => this.persistState(),
    });
    this.web = new WebCoordinator({
      repoRoot: () => this.cfg.repoRoot,
      cfg: () => this.cfg,
      createListener: deps.createWebListener,
      hostApi: () => this.asMcpHost(),
      log: (service, level, message) => this.log(service, level, message),
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
      token: readOrCreateRpcToken(cfg.repoRoot),
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
  private get serviceEnv(): Map<string, string> { return this.env.serviceEnv; }
  private get serviceStartedEnv(): Map<string, string> { return this.env.serviceStartedEnv; }

  private snapshotHost(): SnapshotHost {
    const self = this;
    return {
      get sessionID() { return self.sessionID; },
      get cfg() { return self.cfg; },
      get profile() { return self.profile; },
      get runtimes() { return self.runtimes; },
      get ports() { return self.ports; },
      get serviceProfile() { return self.serviceProfile; },
      get serviceEnv() { return self.serviceEnv; },
      get serviceStartedEnv() { return self.serviceStartedEnv; },
      get clientEnv() { return self.clientEnv; },
      get proxy() { return self.proxy.instance; },
      get mcp() { return self.mcp.instance; },
      get web() { return self.web.instance; },
      get mcpToken() { return self.mcp.token; },
      get mcpTokenAgeMs() { return self.mcp.tokenAgeMs(); },
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
      get serviceSeries() {
        return self.resources.serviceSeries();
      },
      logs: { snapshot: () => self.logs.snapshot() },
      tokens: { storeBackend: () => self.tokens.storeBackend() },
      traceDurationMs: (traceId) => self.spans.envelopeMs(traceId),
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
      get llm() {
        return {
          applyConfig: () => self.llm.applyConfig(),
          setFactory: (factory: LlmSourceFactory) => {
            self.llmFactory = factory;
          },
        };
      },
      get proxy() { return self.proxy.instance; },
      get recipes() { return self.recipes; },
      persistState: () => self.persistState(),
      get configOverlay() { return self.configOverlay; },
      log: (service, level, message) => self.log(service, level, message),
      refreshIdentity: () => self.refreshIdentity(),
      startProxy: () => self.startProxy(),
      stopProxy: () => self.stopProxy(),
      applyProxyConfig: () => self.proxy.applyConfig(),
      reload: () => self.reload(),
      forgetService: (name) => self.forgetService(name),
      syncServiceWatchers: () => self.serviceWatchers.sync(self.cfg.services),
      syncWebListener: () => self.web.sync(),
      refreshSops: () => self.env.refreshSops(),
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
      get serviceEnv() { return self.serviceEnv; },
      get serviceStartedEnv() { return self.serviceStartedEnv; },
      get orchestrator() { return self.orchestrator; },
      get procs() { return self.procs; },
      logs: { append: (event) => self.logs.append(event) },
      get clock() { return self.clock; },
      get tokens() { return self.tokens; },
      get registry() { return self.registry; },
      get proxy() { return self.proxy.instance; },
      get boundTokenURL() { return self.proxy.boundTokenURL; },
      get internalTok() { return self.internalTok; },
      get bus() { return self.bus; },
      inspectProcessFn: (pid) => self.inspectProcessFn(pid),
      processAliveFn: (pid) => self.processAliveFn(pid),
      serviceWorkDir: (svc) => self.serviceWorkDir(svc),
      persistState: () => self.persistState(),
      get configOverlay() { return self.configOverlay; },
      set configOverlay(value) { self.configOverlay = value; },
      setState: (name, state, health, pid, lastError) => self.setState(name, state, health, pid, lastError),
      log: (service, level, message) => self.log(service, level, message),
      get sopsValues() { return self.env.sopsValues; },
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
    this.llmFactory = llmSourceFactory(this.registry?.llmSources ?? []);
    assertPluginLlmSourceTypes(this.registry, this.cfg);
    assertPluginInspectDecoders(this.registry, this.cfg);
    await this.env.refreshSops();
    await this.recoverSession();
    this.serviceWatchers.sync(this.cfg.services);
    watchConfigDir(this.reloadHost());
    this.persistState();
    this.log("devctl", "INFO", `supervisor started session=${this.sessionID}`);
    void this.refreshIdentity();
    this.resources.start();
    await this.telemetry.start();
    await this.llm.start();
    await this.web.start();
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
          overlay: typeof rec.overlay === "string" && rec.overlay !== "" ? rec.overlay : undefined,
          detach: rec.detach === true,
          client_env: asStringRecord(rec.client_env),
          extra_env: asStringRecord(rec.extra_env),
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
      case "llm_calls_page":
        return this.queryLlmCallsPage({
          ...asLlmCallFilter(rec),
          cursor: typeof rec.cursor === "string" ? rec.cursor : undefined,
          limit: typeof rec.limit === "number" ? rec.limit : undefined,
        });
      case "get_llm_call":
        return this.queryLlmCall(typeof rec.id === "string" ? rec.id : "");
      case "traffic_calls_page":
        return this.queryTrafficCallsPage({
          ...asTrafficCallFilter(rec),
          cursor: typeof rec.cursor === "string" ? rec.cursor : undefined,
          limit: typeof rec.limit === "number" ? rec.limit : undefined,
        });
      case "get_traffic_call":
        return this.queryTrafficCall(typeof rec.id === "string" ? rec.id : "");
      case "proxy_start":
        // Only an explicit proxy_start clears suppression — startProxy()
        // itself is also called from start() (service-start auto-bind), which
        // must not have this side effect. Config reload hot-swaps via
        // applyConfig() and never starts a stopped proxy.
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
      case "mcp_rotate":
        await this.mcp.rotate();
        return null;
      case "web_start":
        return { url: await this.web.startExplicit() };
      case "web_stop":
        await this.web.stop();
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
      case "set_service_env":
        return this.commands.setServiceEnvironment.execute(typeof rec.service === "string" ? rec.service : "", typeof rec.name === "string" ? rec.name : "");
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
          // A teardown failure is reported through `stopped` (runDaemon).
          this.shutdown(stopServices).catch(() => undefined);
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
    await this.applySessionOverlay(req.overlay);
    return this.orchestrator.start(req);
  }

  private async applySessionOverlay(name?: string): Promise<void> {
    if (!name) {
      return;
    }
    const previous = this.configOverlay;
    this.configOverlay = name;
    try {
      await this.reload();
    } catch (err) {
      this.configOverlay = previous;
      throw err;
    }
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
      get serviceEnv() {
        return self.serviceEnv;
      },
      get serviceStartedEnv() {
        return self.serviceStartedEnv;
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
      resolveHealthConfig: (name, health, assigned) => resolveHealthConfig(health, self.cfg, name, assigned, self.ports),
      logs: { append: (event) => self.logs.append(event) },
      bus: self.bus,
      processMeta: self.processMeta,
      get containerPrefix() { return `devctl-${repoID(self.cfg.repoRoot, self.cfg.instance.name)}-`; },
      prepareServiceIdentity: (name, svc) => self.identity.prepareServiceIdentity(name, svc),
      resolveServiceExecution: (name, svc, profile, env, clientEnv, includeProcess, selectedEnv) => self.env.resolveServiceExecution(name, svc, profile, env, clientEnv, includeProcess, selectedEnv),
      ensureHttpRecipes: async (names) => {
        for (const recipeName of names) {
          await self.recipes.ensure(recipeName);
        }
      },
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
    const implicit = implicitServiceDependencies(this.cfg, task.environment).map((dep) => dependencyName(dep));
    const deps = [...new Set([...task.dependencies, ...implicit])];
    if (deps.length > 0) {
      await this.start({ services: deps, client_env: clientEnv });
    }
    for (const recipeName of recipesNeededForEnv(this.cfg, task.environment)) {
      await this.recipes.ensure(recipeName);
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
    for (const recipeName of recipesNeededForEnv(this.cfg, effectiveServiceEnv(svc, this.env.serviceEnv.get(service)), profileEnv)) {
      await this.recipes.ensure(recipeName);
    }
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
      logsStats: (req) => this.queryLogsFacets(req),
      listLogSessions: () => listSessions(this.logSessionsRoot()),
      loadLogSession: (id) => this.loadPersistedLogSession(id),
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
      setServiceEnvironment: (service, name) => this.commands.setServiceEnvironment.execute(service, name),
      runTask: (name) => this.runTask(name, {}),
      startProxy: () => this.startProxy(),
      stopProxy: () => this.stopProxy(),
      getTrace: (traceId) => this.queryTrace(traceId),
      traceRequest: (requestId) => this.queryTraceByRequest(requestId),
      llmCallsPage: (req) => this.queryLlmCallsPage(req),
      getLlmCall: (id) => this.queryLlmCall(id),
      trafficCallsPage: (req) => this.queryTrafficCallsPage(req),
      getTrafficCall: (id) => this.queryTrafficCall(id),
      getPreferences: (scope) => this.preferenceSnapshot(scope),
      setPreferences: (patch) => this.setPreferences(patch),
    };
  }

  private preferenceSnapshot(scope?: PreferenceScope) {
    return getPreferenceSnapshot(this.cfg.repoRoot, {
      yamlKeymap: this.cfg.ui.keymap,
      scope: isPreferenceScope(scope) ? scope : "repo",
      webEnabled: this.cfg.web.enabled,
      webPort: this.cfg.web.listen.port,
      inspectMaxBytes: inspectCapBytes(this.cfg.proxy.inspect_max_bytes, this.cfg.llm.capture_max_bytes),
    });
  }

  private async setPreferences(patch: PreferenceWrite) {
    const scope: PreferenceScope = patch.scope === "user" ? "user" : "repo";
    const opts = { repoRoot: this.cfg.repoRoot, scope };
    if (patch.reset === true) {
      resetTuiPreferences(opts);
    } else {
      const partial = tuiPatchFromWrite(patch);
      if (Object.values(partial).some((value) => value !== undefined)) {
        saveTuiPreferences(partial, opts);
      }
    }
    if (patch.local && hasLocalConfigPatch(patch.local)) {
      patchRepoLocalConfig(this.cfg.repoRoot, patch.local);
      await this.reload();
    }
    return this.preferenceSnapshot(scope);
  }

  async reload(): Promise<ReloadResult> {
    return reloadSupervisor(this.reloadHost());
  }

  async shutdown(stopServices: boolean): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    let failure: unknown;
    try {
      await this.teardown(stopServices);
    } catch (err) {
      failure = err ?? new Error("shutdown failed");
      throw err;
    } finally {
      this.markStopped({ servicesStopped: stopServices, failure });
    }
  }

  private async teardown(stopServices: boolean): Promise<void> {
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
    this.recipes.stop();
    await this.stopProxy();
    await this.telemetry.stop();
    await this.llm.stop();
    this.llmStore.close();
    this.trafficStore.close();
    this.spans.close();
    await this.stopMcp();
    await this.web.stop();
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
    return { events: applyRequestIdDedupe(filter, events) };
  }

  // Bounded, cursor-paged counterpart to queryLogs() — added alongside it
  // rather than replacing it so CLI/TUI/MCP consumers can migrate to paging
  // one at a time; queryLogs()/the plain "logs" RPC still returns everything
  // matching, unbounded, until every consumer has moved off it.
  async queryLogsPage(req: LogFilter & LogPageRequest): Promise<LogPage> {
    const filter = this.logFilter(req);
    const page = await this.logs.queryPage(filter, { cursor: req.cursor, direction: req.direction, limit: req.limit });
    return { ...page, events: applyRequestIdDedupe(filter, page.events) };
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

  queryLlmCallsPage(req: LlmCallFilter & LlmCallPageRequest): LlmCallPage {
    return this.llmStore.queryPage(req, { cursor: req.cursor, limit: req.limit });
  }

  queryLlmCall(id: string): LlmCall | undefined {
    return this.llmStore.get(id);
  }

  queryTrafficCallsPage(req: TrafficCallFilter & TrafficCallPageRequest): TrafficCallPage {
    return this.trafficStore.queryPage(req, { cursor: req.cursor, limit: req.limit });
  }

  queryTrafficCall(id: string): TrafficCall | undefined {
    return this.trafficStore.get(id);
  }

  private logSessionsRoot(): string {
    const directory = this.cfg.logs.persistence.directory;
    return directory === "" || directory.startsWith("~/") ? logsDir() : directory;
  }

  private loadPersistedLogSession(id: string): LogEvent[] {
    if (!id.startsWith("session-") || id.includes("/") || id.includes("\\") || id.includes("..")) {
      return [];
    }
    return loadSessionEvents(id, this.logSessionsRoot());
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
      dedupeRequestId: req.dedupeRequestId,
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
    // What the holder must look like to be stopped: the configured service,
    // or for one a reload removed, the process devctl last recorded for it.
    const expected = svc
      ? { args: meta?.command ?? [...svc.command.args], workDir: meta?.cwd ?? this.serviceWorkDir(svc), startTime: meta?.startTime }
      : meta
        ? { args: meta.command, workDir: meta.cwd, startTime: meta.startTime }
        : undefined;
    for (const port of Object.values(ports)) {
      const holder = await findPortHolder(port);
      if (!holder || holder.pid === process.pid) {
        continue;
      }
      if (!expected) {
        this.log(name, "WARN", `port ${port} is held by pid ${holder.pid}; not stopping a process devctl can't match to ${name}`);
        continue;
      }
      const observed = await this.inspectProcessFn(holder.pid);
      if (observed === undefined || observed.command === "" || !provenSameProcess(expected, observed)) {
        this.log(name, "WARN", `port ${port} is held by pid ${holder.pid}, which can't be matched to ${name}; leaving it running`);
        continue;
      }
      try {
        if ((await freePort(holder)) === "stopped") {
          this.log(name, "INFO", `released port ${port} (pid ${holder.pid})`);
        }
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
    this.serviceStartedEnv.delete(name);
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
        env: this.serviceStartedEnv.get(handle.name) ?? this.serviceEnv.get(handle.name),
      });
    }
    const service_environments: Record<string, string> = {};
    for (const [name, envName] of this.serviceEnv) {
      if (envName !== "") {
        service_environments[name] = envName;
      }
    }
    writePersistedState(this.cfg.repoRoot, {
      session_id: this.sessionID,
      repo_root: this.cfg.repoRoot,
      profile: this.profile,
      processes,
      service_environments,
      config_overlay: this.configOverlay,
    });
  }

  setServiceEnvironment(service: string, name: string): { service: string; env: string } {
    const svc = this.cfg.services[service];
    if (!svc) {
      throw newError(KindServiceNotFound, `unknown service "${service}"`);
    }
    if (!serviceHasNamedEnvironments(svc)) {
      throw newError(KindGeneral, `service "${service}" has no named environments`);
    }
    const resolved = resolveEnvironmentName(svc, name);
    if (name !== "" && resolved !== name) {
      throw newError(KindGeneral, `unknown environment "${name}" on service "${service}" (have ${namedEnvironmentNames(svc).join(", ")})`);
    }
    this.serviceEnv.set(service, resolved);
    this.persistState();
    this.bus.publish(newEvent("ServiceEnvironmentChanged", service, { env: resolved }));
    this.log(service, "INFO", `environment set to ${resolved}`);
    return { service, env: resolved };
  }
}

function tuiPatchFromWrite(patch: PreferenceWrite): TuiPreferencePatch {
  const partial: TuiPreferencePatch = {};
  if (patch.theme !== undefined) {
    partial.theme = patch.theme;
  }
  if (patch.font_size !== undefined) {
    partial.font_size = patch.font_size;
  }
  if (patch.mouse !== undefined) {
    partial.mouse = patch.mouse;
  }
  if (patch.leader_timeout !== undefined) {
    partial.leader_timeout = patch.leader_timeout;
  }
  if (patch.scroll_speed !== undefined) {
    partial.scroll_speed = patch.scroll_speed;
  }
  if (patch.log_timestamps !== undefined) {
    partial.log_timestamps = patch.log_timestamps;
  }
  if (patch.log_metadata !== undefined) {
    partial.log_metadata = patch.log_metadata;
  }
  if (patch.web_appearance !== undefined) {
    partial.web_appearance = patch.web_appearance;
  }
  if (patch.mcp_enabled !== undefined) {
    partial.mcp_enabled = patch.mcp_enabled;
  }
  if (patch.mcp_port !== undefined) {
    partial.mcp_port = patch.mcp_port;
  }
  if (patch.mcp_disabled_tools !== undefined) {
    partial.mcp_disabled_tools = patch.mcp_disabled_tools;
  }
  if (patch.mcp_enabled_tools !== undefined) {
    partial.mcp_enabled_tools = patch.mcp_enabled_tools;
  }
  return partial;
}

function applyRequestIdDedupe<T extends LogEvent>(filter: LogFilter, events: T[]): T[] {
  return filter.dedupeRequestId === true ? dedupeLogsByRequestId(events) : events;
}

export function diffReload(prev: DevctlConfig, next: DevctlConfig): ReloadResult {
  return configSnapshotDiff(prev, next);
}
