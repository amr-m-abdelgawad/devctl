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

export type EnvConfig = {
  vars: Record<string, string>;
  required: string[];
  defaults: Record<string, string>;
};

export type HealthCheckConfig = {
  type: string;
  url: string;
  address: string;
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

export type ServiceLogConfig = {
  stdout: boolean;
  stderr: boolean;
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
};

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
  health: HealthCheckConfig;
  identity: IdentityConfig;
  logs: ServiceLogConfig;
  restart: RestartConfig;
  startup: StartupConfig;
  capabilities: string[];
  proxy: RouteConfig[];
  container?: ContainerConfig;
  hooks: HooksConfig;
};

export type ProfileConfig = {
  services: string[];
  environment: Record<string, string>;
};

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
};

export type RouteConfig = {
  name: string;
  match: MatchConfig;
  upstream: UpstreamConfig;
  auth: RouteAuthConfig;
};

export type ProxyConfig = {
  enabled: boolean;
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

export type AuthConfig = {
  refresh_threshold_seconds: number;
};

export type ShutdownConfig = {
  stop_services_on_exit?: boolean;
  grace_seconds: number;
};

export type UIConfig = {
  theme: string;
  keymap: Record<string, string>;
};

export type SecretsConfig = {
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

export type ProjectEnvironmentConfig = {
  sources: string[];
  secrets: Record<string, string>;
};

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
  proxy: ProxyConfig;
  logs: LogConfig;
  auth: AuthConfig;
  shutdown: ShutdownConfig;
  ui: UIConfig;
  secrets: SecretsConfig;
  doctor: DoctorConfig;
  plugins: PluginConfig[];
  environment: ProjectEnvironmentConfig;
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
  return { type: "", url: "", address: "", command: emptyCommand(), interval_seconds: 0, timeout_seconds: 0, start_period_seconds: 0, unhealthy_threshold: 3, healthy_reset_threshold: 10 };
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
    health: emptyHealth(),
    identity: emptyIdentity(),
    logs: { stdout: false, stderr: false },
    restart: { policy: "", max_retries: 0, backoff_seconds: 0 },
    startup: { wait_for_healthy: false, timeout_seconds: 0 },
    capabilities: [],
    proxy: [],
    container: undefined,
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
    proxy: {
      enabled: false,
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
    auth: { refresh_threshold_seconds: DEFAULT_REFRESH_THRESHOLD_SECONDS },
    shutdown: { grace_seconds: DEFAULT_GRACE_SECONDS },
    ui: { theme: "system", keymap: {} },
    secrets: { extra_markers: [], extra_patterns: [] },
    doctor: { tools: [] },
    plugins: [],
    environment: { sources: [], secrets: {} },
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
  if (listen.port === 0) {
    return host;
  }
  return `${host}:${listen.port}`;
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
