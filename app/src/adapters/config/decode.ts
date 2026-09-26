import {
  emptyCommand,
  emptyContainer,
  emptyEnv,
  emptyHealth,
  emptyIdentity,
  emptyProfile,
  emptyService,
  emptyRouteAuth,
  emptyRouteInspect,
  emptyExpose,
  emptyWatch,
  DEFAULT_WATCH_IGNORE,
  watchDebounceMs,
  type Command,
  type EnvConfig,
  type TerraformEnvConfig,
  type ExposeConfig,
  type Dependency,
  type HealthCheckConfig,
  type IdentityConfig,
  type PortSpec,
  type ProfileConfig,
  type RestartConfig,
  type RouteAuthConfig,
  type RouteConfig,
  type RouteGrpcOkEntry,
  type RouteGrpcOkLog,
  type RouteInspectConfig,
  type RouteInspectGrpcConfig,
  type RouteIdentity,
  type RouteLogConfig,
  type RouteTimeoutConfig,
  type RequestBodyReplacement,
  type RouteTransformConfig,
  type ServiceConfig,
  type ServiceLogConfig,
  type ServiceLogMultilineConfig,
  type StartupConfig,
  type TaskConfig,
  type HttpRecipeConfig,
  type HttpExposeConfig,
  emptyHttpRecipe,
  emptyHttpExpose,
} from "../../domain/config/types.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The set of top-level keys a raw YAML node actually declared — the only
// reliable way to tell "explicitly set to false/0/[]" apart from "not set
// at all", since both decode to the same zero value. Merge functions use
// this instead of comparing a decoded value against its zero default.
export function presentKeys(value: unknown): Set<string> {
  return isRecord(value) ? new Set(Object.keys(value)) : new Set();
}

export function asString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

export function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

// Keep unusable values as NaN (and numeric Infinity as Infinity) so validate
// can reject them. asNumber("eight") would become 0.
export function decodeStrictNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

export function asBoolean(value: unknown): boolean {
  return value === true;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => asString(item));
}

export function decodeDependencies(value: unknown): Dependency[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => isRecord(item) ? { service: asString(item.service), condition: asString(item.condition) || "service_started" } : asString(item));
}

export function asStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = asString(item);
  }
  return out;
}

export function decodeCommand(value: unknown): Command {
  if (typeof value === "string") {
    return { args: value.split(/\s+/).filter((part) => part !== ""), shell: false, fromString: true };
  }
  if (Array.isArray(value)) {
    return { args: value.map((item) => asString(item)), shell: false };
  }
  return emptyCommand();
}

export function decodePorts(value: unknown): PortSpec[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === "string" || typeof value === "number") {
    return [decodePortNode(value, "http")];
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => decodePortNode(item, `port_${i}`));
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([name, item]) => decodePortNode(item, name));
  }
  return [];
}

function decodePortNode(value: unknown, name: string): PortSpec {
  if (typeof value === "string" && value.toLowerCase() === "auto") {
    return { name, value: 0, auto: true };
  }
  return { name, value: asNumber(value), auto: false };
}

export function decodeEnv(value: unknown): EnvConfig {
  if (!isRecord(value)) {
    return emptyEnv();
  }
  const vars: Record<string, string> = {};
  let required: string[] = [];
  let defaults: Record<string, string> = {};
  let terraform: TerraformEnvConfig | undefined;
  for (const [key, item] of Object.entries(value)) {
    if (key === "required") {
      required = asStringArray(item);
    } else if (key === "defaults") {
      defaults = asStringMap(item);
    } else if (key === "terraform") {
      terraform = decodeTerraformEnv(item);
    } else {
      vars[key] = asString(item);
    }
  }
  const env: EnvConfig = { vars, required, defaults };
  if (terraform) env.terraform = terraform;
  return env;
}

function decodeTerraformEnv(value: unknown): TerraformEnvConfig | undefined {
  if (typeof value === "string") {
    const path = value.trim();
    if (path === "") return undefined;
    return { path, resource: "", attribute: "" };
  }
  if (!isRecord(value)) {
    return { path: "", resource: "", attribute: "", invalid: true };
  }
  return {
    path: asString(value.path).trim(),
    resource: asString(value.resource).trim(),
    attribute: asString(value.attribute).trim(),
  };
}

export function decodeEnvironments(value: unknown): Record<string, EnvConfig> {
  if (!isRecord(value)) {
    return {};
  }
  const out: Record<string, EnvConfig> = {};
  for (const [name, item] of Object.entries(value)) {
    out[name] = decodeEnv(item);
  }
  return out;
}

export function decodeIdentity(value: unknown): IdentityConfig {
  if (!isRecord(value)) {
    return emptyIdentity();
  }
  return {
    type: asString(value.type),
    mode: asString(value.mode),
    service_account: asString(value.service_account),
    config: isRecord(value.config) ? { ...value.config } : {},
  };
}

export function decodeHealth(value: unknown): HealthCheckConfig {
  if (!isRecord(value)) {
    return emptyHealth();
  }
  return {
    type: asString(value.type),
    url: asString(value.url),
    address: asString(value.address),
    grpc_service: asString(value.grpc_service),
    command: decodeCommand(value.command),
    interval_seconds: asNumber(value.interval_seconds),
    timeout_seconds: asNumber(value.timeout_seconds),
    start_period_seconds: asNumber(value.start_period_seconds),
    unhealthy_threshold: value.unhealthy_threshold === undefined ? 3 : asNumber(value.unhealthy_threshold),
    healthy_reset_threshold: value.healthy_reset_threshold === undefined ? 10 : asNumber(value.healthy_reset_threshold),
  };
}

export function decodeRestart(value: unknown): RestartConfig {
  if (!isRecord(value)) {
    return { policy: "", max_retries: 0, backoff_seconds: 0 };
  }
  const enabled = value.enabled === undefined ? undefined : asBoolean(value.enabled);
  return {
    enabled,
    policy: asString(value.policy),
    max_retries: asNumber(value.max_retries),
    backoff_seconds: asNumber(value.backoff_seconds),
  };
}

export function decodeStartup(value: unknown): StartupConfig {
  if (!isRecord(value)) {
    return { wait_for_healthy: false, timeout_seconds: 0 };
  }
  return {
    wait_for_healthy: asBoolean(value.wait_for_healthy),
    timeout_seconds: asNumber(value.timeout_seconds),
  };
}

export function decodeService(value: unknown): ServiceConfig {
  if (!isRecord(value)) {
    return emptyService();
  }
  return {
    extends: asString(value.extends),
    description: asString(value.description),
    command: decodeCommand(value.command),
    shell: asBoolean(value.shell),
    working_dir: asString(value.working_dir),
    dependencies: decodeDependencies(value.dependencies),
    ports: decodePorts(value.ports),
    environment: decodeEnv(value.environment),
    environments: decodeEnvironments(value.environments),
    default_environment: asString(value.default_environment),
    health: decodeHealth(value.health),
    identity: decodeIdentity(value.identity),
    logs: decodeServiceLogs(value.logs),
    restart: decodeRestart(value.restart),
    startup: decodeStartup(value.startup),
    capabilities: asStringArray(value.capabilities),
    proxy: decodeServiceProxy(value.proxy),
    expose: decodeExpose(value.expose),
    container: decodeContainer(value.container),
    watch: decodeWatch(value.watch),
    hooks: decodeHooks(value.hooks),
  };
}

export function decodeServiceLogs(value: unknown): ServiceLogConfig {
  if (!isRecord(value)) {
    return { stdout: false, stderr: false };
  }
  const logs: ServiceLogConfig = {
    stdout: asBoolean(value.stdout),
    stderr: asBoolean(value.stderr),
  };
  if (value.dedupe_access_line !== undefined) {
    logs.dedupe_access_line = value.dedupe_access_line as boolean;
  }
  if (value.multiline !== undefined) {
    const multiline = decodeServiceLogMultiline(value.multiline);
    if (multiline) {
      logs.multiline = multiline;
    }
  }
  return logs;
}

export function decodeServiceLogMultiline(value: unknown): ServiceLogMultilineConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: ServiceLogMultilineConfig = {};
  if (value.start !== undefined) {
    out.start = asString(value.start);
  }
  if (value.continuation !== undefined) {
    out.continuation = asString(value.continuation);
  }
  if (value.max_wait_ms !== undefined) {
    out.max_wait_ms = asNumber(value.max_wait_ms);
  }
  if (value.max_lines !== undefined) {
    out.max_lines = asNumber(value.max_lines);
  }
  return out;
}

export function decodeWatch(value: unknown): import("../../domain/config/types.ts").ServiceWatchConfig {
  if (!isRecord(value)) {
    return emptyWatch();
  }
  return {
    enabled: asBoolean(value.enabled),
    paths: asStringArray(value.paths),
    debounce_ms: watchDebounceMs(asNumber(value.debounce_ms)),
    ignore: value.ignore === undefined ? [...DEFAULT_WATCH_IGNORE] : asStringArray(value.ignore),
  };
}

export function decodeHooks(value: unknown): import("../../domain/config/types.ts").HooksConfig {
  const raw = isRecord(value) ? value : {};
  return { pre_start: decodeCommand(raw.pre_start), post_start: decodeCommand(raw.post_start) };
}

export function decodeTask(value: unknown): TaskConfig {
  const raw = isRecord(value) ? value : {};
  return { command: decodeCommand(raw.command), shell: asBoolean(raw.shell), working_dir: asString(raw.working_dir), dependencies: asStringArray(raw.dependencies), environment: decodeEnv(raw.environment) };
}

export function decodeContainer(value: unknown): import("../../domain/config/types.ts").ContainerConfig | undefined {
  if (!isRecord(value)) return undefined;
  const ports: Record<string, number> = {};
  if (isRecord(value.ports)) {
    for (const [name, port] of Object.entries(value.ports)) ports[name] = asNumber(port);
  }
  return {
    ...emptyContainer(),
    image: asString(value.image),
    runtime: asString(value.runtime),
    ports,
    env: asStringMap(value.env),
    volumes: asStringArray(value.volumes),
    seed_from: asStringMap(value.seed_from),
    shared_volumes: asStringArray(value.shared_volumes),
    user: asString(value.user),
    memory: asString(value.memory),
    cpus: asString(value.cpus),
    read_only: asBoolean(value.read_only),
    cap_drop: asStringArray(value.cap_drop),
    pids_limit: asNumber(value.pids_limit),
  };
}

// `expose: true` is the common shorthand; an object form turns it on too
// (unless it explicitly sets enabled:false) and carries match/port overrides.
export function decodeExpose(value: unknown): ExposeConfig {
  if (value === true) {
    return { enabled: true, host: "", port: "" };
  }
  if (value === false) {
    return { enabled: false, host: "", port: "" };
  }
  if (isRecord(value)) {
    return {
      enabled: value.enabled !== undefined ? asBoolean(value.enabled) : true,
      host: asString(value.host),
      port: asString(value.port),
    };
  }
  return emptyExpose();
}

export function decodeServiceProxy(value: unknown): RouteConfig[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => decodeRoute(item));
  }
  if (isRecord(value)) {
    return [decodeRoute(value)];
  }
  return [];
}

export function decodeProfile(value: unknown): ProfileConfig {
  if (!isRecord(value)) {
    return emptyProfile();
  }
  return {
    services: asStringArray(value.services),
    environment: asStringMap(value.environment),
    environments: asStringMap(value.environments),
    service_environment: decodeEnvironments(value.service_environment),
  };
}

function decodeRouteIdentity(value: unknown): RouteIdentity {
  if (typeof value === "string") {
    return { type: value, service_account: "" };
  }
  if (!isRecord(value)) {
    return { type: "", service_account: "" };
  }
  return { type: asString(value.type), service_account: asString(value.service_account) };
}

export function decodeRouteAuth(value: unknown): RouteAuthConfig {
  if (!isRecord(value)) {
    return emptyRouteAuth();
  }
  return {
    type: asString(value.type),
    identity: decodeRouteIdentity(value.identity),
    audience: asString(value.audience),
    service_account: asString(value.service_account),
    client_id: asString(value.client_id),
    client_secret: asString(value.client_secret),
    credentials: asString(value.credentials),
    headers: asStringMap(value.headers),
    ...(value.log_identity !== undefined ? { log_identity: asBoolean(value.log_identity) } : {}),
    ...(value.suppress_authorization !== undefined ? { suppress_authorization: asBoolean(value.suppress_authorization) } : {}),
  };
}

export function decodeRouteInspect(value: unknown): RouteInspectConfig {
  if (value === true) {
    return { enabled: true, max_bytes: 0 };
  }
  if (value === false || value === undefined || !isRecord(value)) {
    return emptyRouteInspect();
  }
  const grpc = decodeRouteInspectGrpc(value.grpc);
  return {
    enabled: asBoolean(value.enabled),
    max_bytes: asNumber(value.max_bytes),
    ...(value.capture_sse !== undefined ? { capture_sse: asBoolean(value.capture_sse) } : {}),
    ...(grpc ? { grpc } : {}),
  };
}

function decodeRouteInspectGrpc(value: unknown): RouteInspectGrpcConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return { decoder: asString(value.decoder) };
}

function decodeRouteGrpcOkLog(value: unknown): RouteGrpcOkLog | undefined {
  const text = asString(value);
  return text === "" ? undefined : (text as RouteGrpcOkLog);
}

function decodeRouteGrpcOkStatus(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number.NaN;
}

function decodeRouteGrpcOkEntry(value: unknown): RouteGrpcOkEntry {
  if (!isRecord(value)) {
    return { status: Number.NaN };
  }
  const entry: RouteGrpcOkEntry = { status: decodeRouteGrpcOkStatus(value.status) };
  if (value.methods !== undefined) {
    entry.methods = asStringArray(value.methods);
  }
  if (value.log !== undefined) {
    entry.log = decodeRouteGrpcOkLog(value.log);
  }
  return entry;
}

export function decodeRouteLog(value: unknown): RouteLogConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!isRecord(value.grpc)) {
    return {};
  }
  const ok = Array.isArray(value.grpc.ok) ? value.grpc.ok.map(decodeRouteGrpcOkEntry) : [];
  return { grpc: { ok } };
}

// Keep unusable values as NaN (and numeric Infinity as Infinity) so validate
// can reject them. asNumber("bad") would become 0, which is unlimited.
function decodeTimeoutMs(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function decodeRequestBodyReplacement(value: unknown): RequestBodyReplacement {
  if (!isRecord(value)) {
    return { replace: "", with: "" };
  }
  const rule: RequestBodyReplacement = {
    replace: asString(value.replace),
    with: asString(value.with),
  };
  if (value.regex === true) {
    rule.regex = true;
  }
  return rule;
}

function decodeRouteTransform(value: unknown): RouteTransformConfig {
  const rules = isRecord(value) && Array.isArray(value.request_body) ? value.request_body : [];
  return { request_body: rules.map(decodeRequestBodyReplacement) };
}

function decodeRouteTimeout(value: unknown): RouteTimeoutConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const timeout: RouteTimeoutConfig = {};
  if (value.idle_ms !== undefined) {
    timeout.idle_ms = decodeTimeoutMs(value.idle_ms);
  }
  if (value.total_ms !== undefined) {
    timeout.total_ms = decodeTimeoutMs(value.total_ms);
  }
  return timeout;
}

export function decodeRoute(value: unknown): RouteConfig {
  if (!isRecord(value)) {
    return {
      name: "",
      match: { host: "", path: "" },
      upstream: { url: "" },
      auth: emptyRouteAuth(),
      inspect: emptyRouteInspect(),
    };
  }
  const match = isRecord(value.match) ? value.match : {};
  const upstream = isRecord(value.upstream) ? value.upstream : {};
  return {
    name: asString(value.name),
    transport: asString(value.transport),
    match: { host: asString(match.host), path: asString(match.path) },
    upstream: { url: asString(upstream.url), service: asString(upstream.service), port: asString(upstream.port), recipe: asString(upstream.recipe) },
    auth: decodeRouteAuth(value.auth),
    response_headers: asStringMap(value.response_headers),
    listen: isRecord(value.listen) ? { host: asString(value.listen.host), port: asNumber(value.listen.port) } : undefined,
    inspect: decodeRouteInspect(value.inspect),
    strip_prefix: asBoolean(value.strip_prefix),
    log: decodeRouteLog(value.log),
    timeout: decodeRouteTimeout(value.timeout),
    transform: isRecord(value.transform) ? decodeRouteTransform(value.transform) : undefined,
  };
}

export function decodeHttpExpose(value: unknown): HttpExposeConfig {
  if (value === true) {
    return { enabled: true, host: "", response_headers: {}, allow_token_body: false };
  }
  if (value === false) {
    return { enabled: false, host: "", response_headers: {}, allow_token_body: false };
  }
  if (isRecord(value)) {
    return {
      enabled: value.enabled !== undefined ? asBoolean(value.enabled) : true,
      host: asString(value.host),
      response_headers: asStringMap(value.response_headers),
      allow_token_body: asBoolean(value.allow_token_body),
    };
  }
  return emptyHttpExpose();
}

export function decodeHttpRecipe(value: unknown): HttpRecipeConfig {
  if (!isRecord(value)) {
    return emptyHttpRecipe();
  }
  const request = isRecord(value.request) ? value.request : {};
  const cache = isRecord(value.cache) ? value.cache : {};
  return {
    request: {
      method: asString(request.method),
      url: asString(request.url),
      headers: asStringMap(request.headers),
      body: asString(request.body),
      form: asStringMap(request.form),
      auth: decodeRouteAuth(request.auth),
      timeout_seconds: asNumber(request.timeout_seconds),
    },
    outputs: asStringMap(value.outputs),
    cache: {
      jwt: asBoolean(cache.jwt),
      expires_in: asString(cache.expires_in),
    },
    expose: decodeHttpExpose(value.expose),
  };
}

// applyRoot() and applyProxy() live in merge.ts now — they need mergeService/
// mergeProfile to merge services/profiles/templates against whatever's
// already in cfg (from an earlier file in the same load) rather than just
// decoding into a fresh object, and merge.ts is where that merge logic lives.
