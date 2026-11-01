export type ServiceAccountStatus = "unknown" | "available" | "unavailable";
import type { CredentialsSnapshot, SystemSnapshot } from "../src/domain/status.ts";
export type McpToolRow = { name: string; label: string; summary: string; category: string; mutates: boolean; enabled: boolean };

export type StatusSummary = {
  session_id: string;
  repo_root: string;
  profile: string;
  setup_mode?: boolean;
  identity: {
    user: string;
    project: string;
    project_source?: string;
    adc: boolean;
    iap: boolean;
    service_accounts?: Record<string, boolean>;
    service_account_status?: Record<string, ServiceAccountStatus>;
  };
  proxy: {
    running: boolean;
    address?: string;
    routes?: Array<{ name: string; match?: string; auth?: string }>;
    requestTotal?: number;
    requestErrors?: number;
    recentRequests?: RequestRow[];
  };
  logs: { total: number; errors: number; counts: Record<string, number>; seen?: number; seenErrors?: number };
  mcp: { running: boolean; address?: string; port?: number; disabled_tools?: string[] };
  credentials?: CredentialsSnapshot;
  system?: SystemSnapshot;
  restart_required?: string[];
  web: { running: boolean; address?: string; port?: number };
  stats_series?: { interval_ms: number; cpu: number[]; mem: number[] };
  daemon?: {
    rssBytes: number;
    heapBytes: number;
    memoryLimitBytes?: number;
    nonReapingPid1?: boolean;
    eventLoopLagMs?: number;
    logs?: { inFlightBytes: number; spooledBytes: number; paused: boolean; loss: number; ringBytes: number };
  };
};

export type ServiceRow = {
  name: string;
  state: string;
  health: string;
  ports: Record<string, number>;
  pid: number;
  last_error: string;
  restarts?: number;
  startTime?: string;
  cpuPercent?: number;
  memoryKB?: number;
  env?: string;
  started_env?: string;
  environments?: string[];
  start_period_remaining_ms?: number;
  start_period_total_ms?: number;
};

export type RequestRow = {
  timestamp: string;
  request_id: string;
  trace_id?: string;
  method: string;
  path: string;
  route: string;
  status: number;
  duration_ms: number;
  trace_duration_ms?: number;
  error?: string;
  captured?: boolean;
};

export type RequestsPayload = {
  running: boolean;
  total: number;
  errors: number;
  requests: RequestRow[];
};

export type ConfigService = {
  name: string;
  description: string;
  command?: string[];
  cwd?: string;
  dependencies: Array<string | { service: string; condition?: string }>;
  ports?: Array<{ name: string; value: number; auto?: boolean }>;
  container?: { image?: string; runtime?: string };
};

export type TaskRow = { name: string; dependencies: string[] };

export type ConfigSummary = {
  project: string;
  services: ConfigService[];
  tasks?: TaskRow[];
  config_path?: string;
  repo_root?: string;
  proxy?: {
    enabled: boolean;
    listen: { host: string; port: number };
    routes: Array<{
      name: string;
      match: { host: string; path: string } | string;
      upstream: string;
      auth: string;
      audience?: string;
      identity?: string;
      transport?: string;
      listen?: { host: string; port: number };
      inspect?: unknown;
      strip_prefix?: boolean;
    }>;
  };
};

export type ServiceDetail = Omit<ServiceRow, "environments"> & {
  command: string[];
  cwd: string;
  environment: Record<string, string>;
  environments?: Record<string, Record<string, string>>;
  container?: Record<string, unknown>;
};

export type ConfigSources = {
  entries: Array<{ path: string; value: string; source: string; layer: string; shadowed: Array<{ source: string; layer: string }> }>;
};

export type TaskResult = { task: string; code: number; stdout: string; stderr: string };

export type ProfileRow = { name: string; services: string[] };

export type ControlTool =
  | "start_services"
  | "stop_services"
  | "restart_services"
  | "set_service_environment"
  | "reload_config"
  | "run_task"
  | "start_proxy"
  | "stop_proxy"
  | "set_preferences";

export type ControlArgs = {
  services?: string[];
  profile?: string;
  cascade?: boolean;
  name?: string;
  service?: string;
  restart?: boolean;
  scope?: "user" | "repo";
  theme?: string;
  font_size?: number;
  mouse?: boolean;
  leader_timeout?: number;
  scroll_speed?: number;
  log_timestamps?: boolean;
  log_metadata?: boolean;
  web_appearance?: "dark" | "light";
  mcp_enabled?: boolean;
  regenerate_session_tokens?: boolean;
  mcp_port?: number | null;
  reset?: boolean;
  local?: { web_enabled?: boolean; web_port?: number; inspect_max_bytes?: number };
};

export type PreferenceLayer = "default" | "team" | "user" | "repo" | "override";

export type PreferenceSnapshot = {
  values: {
    theme: string;
    font_size: number;
    mouse: boolean;
    leader_timeout: number;
    scroll_speed: number;
    log_timestamps: boolean;
    log_metadata: boolean;
    web_appearance: "dark" | "light";
    mcp_enabled: boolean;
    mcp_port?: number;
    regenerate_session_tokens: boolean;
  };
  scope: "user" | "repo";
  locked: boolean;
  paths: {
    user: string;
    repo: string;
    write: string;
    team?: string;
    override?: string;
    local: string;
  };
  layers: Record<string, PreferenceLayer>;
  local: {
    web_enabled: boolean;
    web_port: number;
    inspect_max_bytes: number;
  };
};

export type LogRow = {
  timestamp: string;
  service: string;
  source: string;
  severityText: string;
  level: string;
  message: string;
  traceId?: string;
  spanId?: string;
  seq?: number;
  severityNumber?: number;
  body?: unknown;
  attributes?: Record<string, unknown>;
  pid?: number;
};

export type LogsPayload = {
  events: LogRow[];
  truncated?: boolean;
  has_more?: boolean;
  next_cursor?: string;
  prev_cursor?: string;
  session_changed?: boolean;
};

export type LogFacets = {
  total: number;
  byService: Record<string, number>;
  byLevel: Record<string, number>;
  bySource: Record<string, number>;
};

export type LogsQuery = {
  sessionId?: string;
  service?: string;
  level?: string;
  levels?: string[];
  hideHealth?: boolean;
  search?: string;
  regex?: boolean;
  source?: string;
  since?: string;
  until?: string;
  cursor?: string;
  direction?: "forward" | "backward";
  limit?: number;
  hideGrpc?: boolean;
  hideSystem?: boolean;
  excludeServices?: string[];
  requestId?: string;
  traceId?: string;
  attributeKey?: string;
  attributeValue?: string;
  dedupeRequestId?: boolean;
};

export type DoctorSeverity = "ok" | "warn" | "error";

export type DoctorPortHolder = {
  port: number;
  pid: number;
  command: string;
  stack?: string;
};

export type DoctorCheck = {
  name: string;
  severity: DoctorSeverity;
  message: string;
  hint?: string;
  action?: { kind: "free-port"; holder: DoctorPortHolder };
};

export type DoctorReport = {
  checks: DoctorCheck[];
  issues: number;
};

export type SpanRow = {
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: string;
  startUnixNano: number;
  endUnixNano: number;
  status: { code: string; message?: string };
  resource: { "service.name": string; [k: string]: unknown };
  attributes?: Record<string, unknown>;
};

export type TracePayload = {
  trace_id: string;
  request_id?: string;
  spans: SpanRow[];
  logs: LogRow[];
};

export type LlmUsageRow = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type LlmCallRow = {
  id: string;
  source: string;
  source_type: string;
  timestamp: string;
  duration_ms?: number;
  status: string;
  error?: string;
  model: string;
  routed_model?: string;
  vendor?: string;
  operation: string;
  caller?: string;
  usage?: LlmUsageRow;
  cost?: number;
  request?: unknown;
  response?: unknown;
  attributes: Record<string, unknown>;
  request_id?: string;
  trace_id?: string;
};

export type LlmCallsPayload = {
  calls: LlmCallRow[];
  has_more?: boolean;
  next_cursor?: string;
  errors?: Array<{ source: string; message: string; status?: number }>;
};

export type TrafficPayload = {
  text?: string;
  data?: string;
  encoding?: "utf8" | "base64";
  omitted?: boolean;
  truncated?: boolean;
  contentType?: string;
};

export type TrafficCallRow = {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  route: string;
  transport: string;
  caller?: string;
  status: number;
  grpc_status?: string;
  duration_ms?: number;
  request?: TrafficPayload;
  response?: TrafficPayload;
  attributes: Record<string, unknown>;
  request_id?: string;
  trace_id?: string;
};

export type TrafficCallsPayload = {
  calls: TrafficCallRow[];
  has_more?: boolean;
  next_cursor?: string;
};

export type RouteName =
  | "services"
  | "traces"
  | "graph"
  | "logs"
  | "llm"
  | "traffic"
  | "settings"
  | "doctor"
  | "identity"
  | "workspace"
  | "config"
  | "proxy"
  | "system";

export type Route = {
  name: RouteName;
  serviceId?: string;
  logService?: string;
  logSeq?: number;
  traceId?: string;
  llmId?: string;
  trafficId?: string;
};

export type UpdateCheckPayload = {
  current: string;
  latest: string;
  newer: boolean;
  hint: string;
  kind: string;
  command?: string[];
};
