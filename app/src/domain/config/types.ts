export const CurrentVersion = 1;

export const RestartNever = "never";
export const RestartOnFailure = "on_failure";
export const RestartAlways = "always";

export type RestartPolicy = typeof RestartNever | typeof RestartOnFailure | typeof RestartAlways;

export type Command = {
  readonly args: string[];
  readonly shell: boolean;
};

export type PortSpec = {
  readonly name: string;
  readonly value: number;
  readonly auto: boolean;
};

/** Literal env read from a service's Terraform. `invalid` is a decode sentinel. */
export type TerraformEnvConfig = {
  path: string;
  resource: string;
  attribute: string;
  invalid?: boolean;
};

export type EnvConfig = {
  vars: Record<string, string>;
  required: string[];
  defaults: Record<string, string>;
  terraform?: TerraformEnvConfig;
};

export type HealthCheckConfig = {
  type: string;
  url: string;
  address: string;
  // Health protocol service name for type: grpc. Empty (the default) is overall status.
  grpc_service?: string;
  command: Command;
  interval_seconds: number;
  timeout_seconds: number;
  start_period_seconds: number;
  unhealthy_threshold: number;
  healthy_reset_threshold: number;
};

export type DependencyConfig = { service: string; condition: string };
export type Dependency = string | DependencyConfig;

export type IdentityConfig = {
  type: string;
  mode: string;
  service_account: string;
  config?: Record<string, unknown>;
};

export type ServiceLogMultilineConfig = {
  start?: string;
  continuation?: string;
  max_wait_ms?: number;
  max_lines?: number;
};

export type ServiceLogConfig = {
  stdout: boolean;
  stderr: boolean;
  multiline?: ServiceLogMultilineConfig;
  dedupe_access_line?: boolean;
};

export type RestartConfig = {
  enabled?: boolean;
  policy: string;
  max_retries: number;
  backoff_seconds: number;
};

export type StartupConfig = {
  wait_for_healthy: boolean;
  timeout_seconds: number;
};

export type ContainerConfig = {
  image: string;
  runtime: string;
  ports: Record<string, number>;
  env: Record<string, string>;
  volumes: string[];
  user: string;
  memory: string;
  cpus: string;
  read_only: boolean;
  cap_drop: string[];
  pids_limit: number;
};

export function emptyContainer(): ContainerConfig {
  return {
    image: "",
    runtime: "",
    ports: {},
    env: {},
    volumes: [],
    user: "",
    memory: "",
    cpus: "",
    read_only: false,
    cap_drop: [],
    pids_limit: 0,
  };
}

export type ServiceWatchConfig = {
  enabled: boolean;
  paths: string[];
  debounce_ms: number;
  ignore: string[];
};

export const DEFAULT_WATCH_DEBOUNCE_MS = 300;
export const DEFAULT_WATCH_IGNORE = ["**/node_modules/**", "**/.git/**"];

export function watchDebounceMs(value: number): number {
  return value > 0 ? value : DEFAULT_WATCH_DEBOUNCE_MS;
}

export function emptyWatch(): ServiceWatchConfig {
  return { enabled: false, paths: [], debounce_ms: DEFAULT_WATCH_DEBOUNCE_MS, ignore: [...DEFAULT_WATCH_IGNORE] };
}

export type HooksConfig = { pre_start: Command; post_start: Command };

export type TaskConfig = { command: Command; shell: boolean; working_dir: string; dependencies: string[]; environment: EnvConfig };

export type ServiceConfig = {
  extends: string;
  description: string;
  command: Command;
  shell: boolean;
  working_dir: string;
  dependencies: Dependency[];
  ports: PortSpec[];
  environment: EnvConfig;
  // Named env overlays the operator can switch per service (local vs deployed, …).
  // Each value has the same shape as `environment`. The selected name is session
  // state, not this snapshot; `default_environment` is the YAML default.
  environments: Record<string, EnvConfig>;
  default_environment: string;
  health: HealthCheckConfig;
  identity: IdentityConfig;
  logs: ServiceLogConfig;
  restart: RestartConfig;
  startup: StartupConfig;
  capabilities: string[];
  proxy: RouteConfig[];
  expose: ExposeConfig;
  container?: ContainerConfig;
  watch: ServiceWatchConfig;
  hooks: HooksConfig;
};

// Opt-in for a service to be reachable through the proxy by a stable, logical
// address instead of its (possibly changing) port. `expose: true` in YAML
// decodes to { enabled: true }; `host` overrides the synthesized route's match
// host (default "<service>.local"), and `port` selects which named port to
// forward to (default "http"). Exposure is host-based only — the proxy
// forwards the request path verbatim, so a path prefix belongs on a
// hand-written route, not here.
//
// `enabled` is tri-state so the decoder can tell three cases apart:
//   undefined → not set (gateway may still expose it)
//   true      → always exposed
//   false     → explicit opt-out, honored even under `proxy.gateway`.
export type ExposeConfig = {
  enabled?: boolean;
  host: string;
  port: string;
};

export function emptyExpose(): ExposeConfig {
  return { enabled: undefined, host: "", port: "" };
}

export type ProfileConfig = {
  services: string[];
  environment: Record<string, string>;
  // service name → `services.<name>.environments.<overlay>` to apply when this
  // profile is the launch context.
  environments: Record<string, string>;
  // Per-service EnvConfig that wins over that service's own vars.
  service_environment: Record<string, EnvConfig>;
};

export function emptyProfile(init: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    services: init.services ?? [],
    environment: init.environment ?? {},
    environments: init.environments ?? {},
    service_environment: init.service_environment ?? {},
  };
}

export type ProjectConfig = {
  name: string;
};

export type GoogleConfig = {
  project_id: string;
  region: string;
};

export type ListenConfig = {
  host: string;
  port: number;
};

export type TokenEndpointConfig = {
  enabled: boolean;
  host: string;
  port: number;
};

export type MatchConfig = {
  host: string;
  path: string;
};

export type UpstreamConfig = {
  url: string;
  // A route synthesized from `expose`/`proxy.gateway` addresses its target by
  // service + port name rather than a fixed url, so the proxy can resolve the
  // *current* assigned port at request time (see ProxyServer.resolvePort) — a
  // service that restarts on a new auto-assigned port is then followed without
  // a proxy reload. Hand-written routes omit both and use `url`.
  service?: string;
  port?: string;
  // A route synthesized from `http.<name>.expose` returns the cached recipe
  // response instead of forwarding to a url or service.
  recipe?: string;
};

export type RouteIdentity = {
  type: string;
  service_account: string;
};

export type RouteAuthConfig = {
  type: string;
  identity: RouteIdentity;
  audience: string;
  service_account: string;
  client_id: string;
  client_secret: string;
  // Path to a gcloud authorized_user JSON (client_id/client_secret/refresh_token)
  // used to mint IAP tokens for a custom client_id, instead of the default
  // gcloud ADC — so ADC stays intact for GCS/Firestore. Resolved to an absolute
  // path at load; only meaningful on an IAP route with a client_id. Falls back
  // to proxy.credentials when unset.
  credentials?: string;
  // Extra request headers injected alongside Authorization, for upstreams that
  // want the minted token under another header too. `${token}` in a value is
  // replaced with the same token used for the Authorization bearer. Applied
  // only on a token-minting route (iap / service_account).
  headers?: Record<string, string>;
  // On auth.type none (or empty) only: copy inbound X-Goog-Authenticated-User-Email
  // onto the traffic record as callerEmail. Does not mint tokens. Invalid on
  // iap / service_account / other minting types.
  log_identity?: boolean;
  // On iap / service_account only: mint the token and apply auth.headers, but
  // do not write Authorization: Bearer. Lets a caller keep its own
  // Authorization (e.g. a Workspace OAuth token) while IAP goes in
  // Proxy-Authorization via auth.headers. Requires auth.headers so the minted
  // token is sent somewhere. Invalid on auth.type none.
  suppress_authorization?: boolean;
};

export function emptyRouteAuth(): RouteAuthConfig {
  return {
    type: "",
    identity: { type: "", service_account: "" },
    audience: "",
    service_account: "",
    client_id: "",
    client_secret: "",
    credentials: "",
    headers: {},
  };
}

export function routeAuthIsNone(auth: Pick<RouteAuthConfig, "type">): boolean {
  const t = auth.type.trim().toLowerCase();
  return t === "" || t === "none";
}

// Per-route body capture for the traffic inspector. Default off so existing
// routes stay metadata-only. max_bytes 0 means the 1 MiB default.
export const DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES = 1_048_576;

export type RouteInspectGrpcConfig = {
  decoder?: string;
};

export type RouteInspectConfig = {
  enabled: boolean;
  max_bytes: number;
  grpc?: RouteInspectGrpcConfig;
  // When true, text/event-stream responses are stored as SSE frames (or a
  // reassembled OpenAI chat.completion). Default false: raw teed text.
  capture_sse?: boolean;
};

export function emptyRouteInspect(): RouteInspectConfig {
  return { enabled: false, max_bytes: 0 };
}

export function routeInspectDecoder(route: RouteConfig): string {
  return (route.inspect?.grpc?.decoder ?? "").trim();
}

export function routeInspectEnabled(route: RouteConfig): boolean {
  return route.inspect?.enabled === true;
}

export const INSPECT_CAP_PRESETS = [
  DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES,
  4 * DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES,
  8 * DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES,
  16 * DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES,
] as const;

export function inspectCapBytes(explicit: number, fallback = 0): number {
  if (explicit > 0) {
    return explicit;
  }
  if (fallback > 0) {
    return fallback;
  }
  return DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES;
}

export function routeInspectMaxBytes(route: RouteConfig, fallback = 0): number {
  return inspectCapBytes(route.inspect?.max_bytes ?? 0, fallback);
}

export function formatInspectCap(bytes: number): string {
  return `${bytes / DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES} MiB`;
}

export function cycleInspectCap(current: number, dir: 1 | -1): number {
  const presets = [...INSPECT_CAP_PRESETS];
  const found = presets.indexOf(current as (typeof INSPECT_CAP_PRESETS)[number]);
  const start = found < 0 ? 0 : found;
  return presets[(start + dir + presets.length) % presets.length] ?? DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES;
}

export function routeInspectCaptureSse(route: RouteConfig): boolean {
  return route.inspect?.capture_sse === true;
}

export const ROUTE_GRPC_OK_LOG_INFO = "info";
export const ROUTE_GRPC_OK_LOG_SILENT = "silent";
export type RouteGrpcOkLog = typeof ROUTE_GRPC_OK_LOG_INFO | typeof ROUTE_GRPC_OK_LOG_SILENT;

export type RouteGrpcOkEntry = {
  status: number;
  methods?: string[];
  log?: RouteGrpcOkLog;
};

export type RouteLogGrpcConfig = {
  ok?: RouteGrpcOkEntry[];
};

export type RouteLogConfig = {
  grpc?: RouteLogGrpcConfig;
};

// Opt-in per-route hop deadlines. Omitted, missing keys, or 0 = unlimited
// (today's behavior). A global default would kill 47–65s CopilotKit streams.
export type RouteTimeoutConfig = {
  idle_ms?: number;
  total_ms?: number;
};

// One request-body rewrite applied before the hop is forwarded. `regex` omitted
// or false means `replace` is a literal string. `with` is inserted literally.
export type RequestBodyReplacement = {
  replace: string;
  with: string;
  regex?: boolean;
};

export type RouteTransformConfig = {
  request_body: RequestBodyReplacement[];
};

export type RouteConfig = {
  name: string;
  // "" / "http" (default) → the shared HTTP/1.1 listener, matched by host/path.
  // "grpc" → a dedicated loopback HTTP/2 (h2c) listener on `listen` that
  // forwards every stream to `upstream` over h2+TLS, injecting the route's auth
  // (so a gRPC client such as a Temporal worker stays token-free).
  transport?: string;
  match: MatchConfig;
  upstream: UpstreamConfig;
  auth: RouteAuthConfig;
  // Headers added to every response on this route (overriding the upstream's),
  // e.g. CORS `Access-Control-Allow-*`. A CORS preflight (OPTIONS carrying
  // Access-Control-Request-Method) is answered directly with these headers, not
  // forwarded — so the proxy is the single entry point for both CORS and auth.
  response_headers?: Record<string, string>;
  // Only for a grpc route: the dedicated loopback address the client dials.
  listen?: ListenConfig;
  // Opt-in HTTP/gRPC body capture for the traffic inspector. Ignored when the
  // proxy is off. Recipe `expose` routes are never captured as live RPCs.
  inspect?: RouteInspectConfig;
  // When forwarding, strip match.path from the inbound pathname. No-op if
  // match.path is empty (host-based expose routes). Inspector and proxy logs
  // keep the inbound path.
  strip_prefix?: boolean;
  // Per-route log policy. log.grpc.ok lists non-zero gRPC statuses that are
  // not proxy errors (no stats().errors increment; INFO or silent).
  log?: RouteLogConfig;
  // Opt-in idle/total deadlines. 0 or omitted = unlimited.
  timeout?: RouteTimeoutConfig;
  // Opt-in request-body rewrites applied before forwarding. HTTP routes only.
  transform?: RouteTransformConfig;
};

export function isGrpcRoute(route: RouteConfig): boolean {
  return (route.transport ?? "").toLowerCase() === "grpc";
}

export type ProxyConfig = {
  enabled: boolean;
  // Default body cap for inspect-enabled routes whose inspect.max_bytes is 0.
  // 0 means the 1 MiB product default. A route that sets max_bytes > 0 wins.
  inspect_max_bytes: number;
  // When true, every HTTP-capable service (one with a port named "http") is
  // exposed through the proxy as if it declared `expose: true`, unless a
  // hand-written route already claims its name. Sugar over per-service
  // `expose`; both synthesize the same kind of service-reference route.
  // Selective exposure is `gateway` off plus per-service `expose` — there is
  // no opt-out flag once gateway is on.
  gateway: boolean;
  // Default authorized_user credentials file for every IAP route that does not
  // set its own auth.credentials (see RouteAuthConfig.credentials). Resolved to
  // an absolute path at load.
  credentials: string;
  listen: ListenConfig;
  token_endpoint: TokenEndpointConfig;
  routes: RouteConfig[];
};

export type PersistenceConfig = {
  enabled: boolean;
  directory: string;
  retention_days: number;
  max_session_logs: number;
};

export type LogConfig = {
  max_memory_events: number;
  persistence: PersistenceConfig;
};

export type TelemetryOtlpConfig = {
  enabled: boolean;
  listen: ListenConfig;
};

export type TelemetryConfig = {
  otlp: TelemetryOtlpConfig;
};

export const DEFAULT_OTLP_HTTP_PORT = 4318;

export type WebConfig = {
  enabled: boolean;
  listen: ListenConfig;
};

export const DEFAULT_WEB_PORT = 18900;

export type AuthConfig = {
  refresh_threshold_seconds: number;
};

export const HTTP_RESERVED_OUTPUTS = ["body", "url", "status"] as const;
export const DEFAULT_HTTP_TIMEOUT_SECONDS = 10;

export type HttpRequestConfig = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  form: Record<string, string>;
  auth: RouteAuthConfig;
  timeout_seconds: number;
};

export type HttpCacheConfig = {
  jwt: boolean;
  expires_in: string;
};

export type HttpExposeConfig = {
  enabled: boolean;
  host: string;
  response_headers: Record<string, string>;
  // Opt-in acknowledgement that the exposed recipe body may contain token
  // material (an access_token/id_token/token output, or a JWT-cached body).
  // The synthesized expose route serves the cached body with no inbound auth,
  // so config validation refuses such a recipe unless this is set.
  allow_token_body: boolean;
};

export type HttpRecipeConfig = {
  request: HttpRequestConfig;
  outputs: Record<string, string>;
  cache: HttpCacheConfig;
  expose: HttpExposeConfig;
};

export function emptyHttpRequest(): HttpRequestConfig {
  return {
    method: "",
    url: "",
    headers: {},
    body: "",
    form: {},
    auth: emptyRouteAuth(),
    timeout_seconds: 0,
  };
}

export function emptyHttpCache(): HttpCacheConfig {
  return { jwt: false, expires_in: "" };
}

export function emptyHttpExpose(): HttpExposeConfig {
  return { enabled: false, host: "", response_headers: {}, allow_token_body: false };
}

export function emptyHttpRecipe(): HttpRecipeConfig {
  return {
    request: emptyHttpRequest(),
    outputs: {},
    cache: emptyHttpCache(),
    expose: emptyHttpExpose(),
  };
}

export function httpCacheEnabled(recipe: HttpRecipeConfig): boolean {
  return recipe.cache.jwt || recipe.cache.expires_in !== "";
}

export function isReservedHttpOutput(name: string): boolean {
  return (HTTP_RESERVED_OUTPUTS as readonly string[]).includes(name);
}

export function httpRecipeEnvUrlKey(name: string): string {
  return `DEVCTL_HTTP_${name.replaceAll("-", "_").toUpperCase()}_URL`;
}

export function httpRecipeLocalUrl(cfg: Pick<DevctlConfig, "http" | "proxy">, name: string): string {
  const host = cfg.http[name]?.expose.host || `${name}.local`;
  return `http://${host}:${cfg.proxy.listen.port}`;
}

export function httpTimeoutSeconds(recipe: HttpRecipeConfig): number {
  return recipe.request.timeout_seconds > 0 ? recipe.request.timeout_seconds : DEFAULT_HTTP_TIMEOUT_SECONDS;
}

export type ShutdownConfig = {
  stop_services_on_exit?: boolean;
  grace_seconds: number;
};

export type UIConfig = {
  theme: string;
  keymap: Record<string, string>;
};

export type SecretsConfig = {
  redact: boolean;
  extra_markers: string[];
  extra_patterns: string[];
};

export type ToolCheck = {
  name: string;
  command: string;
};

export type DoctorConfig = {
  tools: ToolCheck[];
};

export type PluginConfig = {
  path: string;
};

export type SopsConfig = {
  file: string;
  input_type: string;
  key_map: Record<string, string>;
};

export function emptySops(): SopsConfig {
  return { file: "", input_type: "", key_map: {} };
}

export type ProjectEnvironmentConfig = {
  sources: string[];
  secrets: Record<string, string>;
  sops: SopsConfig;
};

export const LLM_SOURCE_TYPE_LITELLM = "litellm";
export const LLM_SOURCE_TYPE_PROXY = "proxy";
export const LLM_AUTH_BEARER = "bearer";
export const DEFAULT_LLM_AUTH_HEADER = "Authorization";
export const DEFAULT_LLM_POLL_SECONDS = 5;
export const DEFAULT_LLM_PORT_NAME = "http";
// Per-direction cap on bytes retained for a proxy-captured body (1 MiB). The
// full body is always forwarded; only the stored copy is bounded.
export const DEFAULT_LLM_CAPTURE_MAX_BYTES = 1_048_576;

export type LlmAuthConfig = {
  type: string;
  token_env: string;
  header: string;
};

export type LlmViaConfig = {
  route: string;
  routes: string[];
};

export type LlmCaptureFieldMap = {
  model?: string;
  prompt_tokens?: string;
  completion_tokens?: string;
  cost?: string;
  finish_reason?: string;
};

export type LlmCaptureConfig = {
  prompts: boolean;
  max_bytes: number;
  paths: string[];
  field_map?: LlmCaptureFieldMap;
};

export type LlmCostPerTokenConfig = {
  input: number;
  output: number;
};

export type LlmSourceConfig = {
  name: string;
  type: string;
  service: string;
  port: string;
  endpoint: string;
  path_prefix: string;
  headers: Record<string, string>;
  via: LlmViaConfig;
  management_endpoint: string;
  management_service: string;
  management_port: string;
  auth: LlmAuthConfig;
  capture: LlmCaptureConfig;
  poll_seconds: number;
  // proxy source only: per-token rates for estimateLlmCost. Omitted when unset.
  cost_per_token?: LlmCostPerTokenConfig;
};

export type LlmConfig = {
  enabled: boolean;
  // Default body cap for sources whose capture.max_bytes is 0. 0 means 1 MiB.
  capture_max_bytes: number;
  sources: LlmSourceConfig[];
};

export function emptyLlmAuth(): LlmAuthConfig {
  return { type: "", token_env: "", header: "" };
}

export function emptyLlmVia(): LlmViaConfig {
  return { route: "", routes: [] };
}

// Union of trimmed via.route (singular sugar) then via.routes, skipping
// empties and keeping first-seen order so capture matching is a list.
export function llmViaRoutes(via: LlmViaConfig): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const name = value.trim();
    if (name === "" || seen.has(name)) {
      return;
    }
    seen.add(name);
    names.push(name);
  };
  push(via.route);
  for (const name of via.routes ?? []) {
    push(name);
  }
  return names;
}

export function emptyLlmCapture(): LlmCaptureConfig {
  return { prompts: true, max_bytes: 0, paths: [] };
}

export function emptyLlmSource(): LlmSourceConfig {
  return {
    name: "",
    type: "",
    service: "",
    port: "",
    endpoint: "",
    path_prefix: "",
    headers: {},
    via: emptyLlmVia(),
    management_endpoint: "",
    management_service: "",
    management_port: "",
    auth: emptyLlmAuth(),
    capture: emptyLlmCapture(),
    poll_seconds: 0,
  };
}

export function emptyLlm(): LlmConfig {
  return { enabled: false, capture_max_bytes: 0, sources: [] };
}

export function llmAuthHeader(auth: LlmAuthConfig): string {
  return auth.header.trim() === "" ? DEFAULT_LLM_AUTH_HEADER : auth.header.trim();
}

export function llmSourcePort(source: LlmSourceConfig): string {
  return source.port.trim() === "" ? DEFAULT_LLM_PORT_NAME : source.port.trim();
}

export function llmManagementPort(source: LlmSourceConfig): string {
  return source.management_port.trim() === "" ? DEFAULT_LLM_PORT_NAME : source.management_port.trim();
}

export function llmCaptureMaxBytes(capture: LlmCaptureConfig, fallback = 0): number {
  return inspectCapBytes(capture.max_bytes, fallback);
}

export type ConfigOrigin = {
  source: string;
  layer: string;
};

export type ConfigProvenance = Record<string, ConfigOrigin[]>;

export type DevctlConfig = {
  version: number;
  project: ProjectConfig;
  google: GoogleConfig;
  profiles: Record<string, ProfileConfig>;
  templates: Record<string, ServiceConfig>;
  services: Record<string, ServiceConfig>;
  tasks: Record<string, TaskConfig>;
  http: Record<string, HttpRecipeConfig>;
  proxy: ProxyConfig;
  logs: LogConfig;
  telemetry: TelemetryConfig;
  web: WebConfig;
  auth: AuthConfig;
  shutdown: ShutdownConfig;
  ui: UIConfig;
  secrets: SecretsConfig;
  doctor: DoctorConfig;
  plugins: PluginConfig[];
  environment: ProjectEnvironmentConfig;
  llm: LlmConfig;
  provenance: ConfigProvenance;
  repoRoot: string;
  configPath: string;
};

export const DEFAULT_PROXY_PORT = 8080;
export const DEFAULT_GRACE_SECONDS = 10;
export const DEFAULT_REFRESH_THRESHOLD_SECONDS = 300;
export const DEFAULT_MAX_MEMORY_EVENTS = 50000;
export const DEFAULT_RETENTION_DAYS = 14;
export const LOCALHOST = "127.0.0.1";

export function emptyCommand(): Command {
  return { args: [], shell: false };
}

export function emptyEnv(): EnvConfig {
  return { vars: {}, required: [], defaults: {} };
}

export function emptyHealth(): HealthCheckConfig {
  return { type: "", url: "", address: "", grpc_service: "", command: emptyCommand(), interval_seconds: 0, timeout_seconds: 0, start_period_seconds: 0, unhealthy_threshold: 3, healthy_reset_threshold: 10 };
}

export function dependencyName(dep: Dependency): string { return typeof dep === "string" ? dep : dep.service; }
export function dependencyCondition(dep: Dependency): string { return typeof dep === "string" ? "service_started" : (dep.condition || "service_started"); }
export function dependencyLabel(dep: Dependency): string { return dependencyCondition(dep) === "service_healthy" ? `${dependencyName(dep)} (healthy)` : dependencyName(dep); }

export function emptyIdentity(): IdentityConfig {
  return { type: "", mode: "", service_account: "", config: {} };
}

export function emptyService(): ServiceConfig {
  return {
    extends: "",
    description: "",
    command: emptyCommand(),
    shell: false,
    working_dir: "",
    dependencies: [],
    ports: [],
    environment: emptyEnv(),
    environments: {},
    default_environment: "",
    health: emptyHealth(),
    identity: emptyIdentity(),
    logs: { stdout: false, stderr: false },
    restart: { policy: "", max_retries: 0, backoff_seconds: 0 },
    startup: { wait_for_healthy: false, timeout_seconds: 0 },
    capabilities: [],
    proxy: [],
    expose: emptyExpose(),
    container: undefined,
    watch: emptyWatch(),
    hooks: { pre_start: emptyCommand(), post_start: emptyCommand() },
  };
}

export function defaultConfig(): DevctlConfig {
  return {
    version: CurrentVersion,
    project: { name: "" },
    google: { project_id: "", region: "" },
    profiles: {},
    templates: {},
    services: {},
    tasks: {},
    http: {},
    proxy: {
      enabled: false,
      inspect_max_bytes: 0,
      gateway: false,
      credentials: "",
      listen: { host: LOCALHOST, port: 0 },
      token_endpoint: { enabled: false, host: "", port: 0 },
      routes: [],
    },
    logs: {
      max_memory_events: DEFAULT_MAX_MEMORY_EVENTS,
      persistence: {
        enabled: true,
        directory: "~/.devctl/logs",
        retention_days: DEFAULT_RETENTION_DAYS,
        max_session_logs: 0,
      },
    },
    telemetry: {
      otlp: {
        enabled: false,
        listen: { host: LOCALHOST, port: DEFAULT_OTLP_HTTP_PORT },
      },
    },
    web: {
      enabled: false,
      listen: { host: LOCALHOST, port: DEFAULT_WEB_PORT },
    },
    auth: { refresh_threshold_seconds: DEFAULT_REFRESH_THRESHOLD_SECONDS },
    shutdown: { grace_seconds: DEFAULT_GRACE_SECONDS },
    ui: { theme: "system", keymap: {} },
    secrets: { redact: true, extra_markers: [], extra_patterns: [] },
    doctor: { tools: [] },
    plugins: [],
    environment: { sources: [], secrets: {}, sops: emptySops() },
    llm: emptyLlm(),
    provenance: {},
    repoRoot: "",
    configPath: "",
  };
}

export function commandEmpty(c: Command): boolean {
  return c.args.length === 0 || (c.args.length === 1 && (c.args[0] ?? "").trim() === "");
}

export function identityKind(ident: IdentityConfig): string {
  if (ident.type !== "") {
    return ident.type;
  }
  return ident.mode;
}

export function isServiceAccountIdentity(ident: IdentityConfig): boolean {
  const kind = identityKind(ident).toLowerCase();
  return kind === "service" || kind === "service_account";
}

export function isUserIdentity(ident: IdentityConfig): boolean {
  const kind = identityKind(ident).toLowerCase();
  return kind === "user" || kind === "";
}

export function effectiveRestartPolicy(r: RestartConfig): RestartPolicy {
  if (r.policy !== "") {
    if (r.policy === RestartAlways || r.policy === RestartOnFailure || r.policy === RestartNever) {
      return r.policy;
    }
    return r.policy as RestartPolicy;
  }
  if (r.enabled === true) {
    return RestartOnFailure;
  }
  return RestartNever;
}

export function listenAddress(listen: ListenConfig): string {
  const host = listen.host === "" ? LOCALHOST : listen.host;
  if (!hasListenPort(listen)) {
    return host;
  }
  return `${host}:${listen.port}`;
}

export function hasListenPort(listen?: ListenConfig): boolean {
  return (listen?.port ?? 0) > 0;
}

export function refreshThreshold(auth: AuthConfig): number {
  if (auth.refresh_threshold_seconds <= 0) {
    return DEFAULT_REFRESH_THRESHOLD_SECONDS;
  }
  return auth.refresh_threshold_seconds;
}

export function stopOnExit(s: ShutdownConfig): boolean {
  if (s.stop_services_on_exit === undefined) {
    return true;
  }
  return s.stop_services_on_exit;
}

export function graceSeconds(s: ShutdownConfig): number {
  if (s.grace_seconds <= 0) {
    return DEFAULT_GRACE_SECONDS;
  }
  return s.grace_seconds;
}

export function captureStdout(svc: ServiceConfig): boolean {
  if (!svc.logs.stdout && !svc.logs.stderr) {
    return true;
  }
  return svc.logs.stdout;
}

export function captureStderr(svc: ServiceConfig): boolean {
  if (!svc.logs.stdout && !svc.logs.stderr) {
    return true;
  }
  return svc.logs.stderr;
}

export function serviceNames(cfg: DevctlConfig): string[] {
  return Object.keys(cfg.services);
}

export function namedPort(ports: PortSpec[], name: string): PortSpec | undefined {
  return ports.find((p) => p.name === name);
}

export function firstPort(ports: PortSpec[]): PortSpec | undefined {
  return ports[0];
}
