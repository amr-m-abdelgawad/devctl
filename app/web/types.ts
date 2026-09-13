export type StatusSummary = {
  session_id: string;
  repo_root: string;
  profile: string;
  setup_mode?: boolean;
  identity: {
    user: string;
    project: string;
    adc: boolean;
    iap: boolean;
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
  mcp: { running: boolean; address?: string; port?: number };
  web: { running: boolean; address?: string; port?: number };
  stats_series?: { interval_ms: number; cpu: number[]; mem: number[] };
};

export type ServiceRow = {
  name: string;
  state: string;
  health: string;
  ports: Record<string, number>;
  pid: number;
  last_error: string;
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
  dependencies: Array<string | { service: string; condition?: string }>;
  ports?: Array<{ name: string; value: number; auto?: boolean }>;
  container?: { image?: string; runtime?: string };
};

export type TaskRow = { name: string; dependencies: string[] };

export type ConfigSummary = {
  project: string;
  services: ConfigService[];
  tasks?: TaskRow[];
};

export type ProfileRow = { name: string; services: string[] };

export type ControlTool =
  | "start_services"
  | "stop_services"
  | "restart_services"
  | "reload_config"
  | "run_task"
  | "start_proxy"
  | "stop_proxy";

export type ControlArgs = {
  services?: string[];
  profile?: string;
  cascade?: boolean;
  name?: string;
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
};

export type LogsPayload = {
  events: LogRow[];
  truncated?: boolean;
  has_more?: boolean;
  next_cursor?: string;
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

export type RouteName = "services" | "traces" | "graph" | "logs";

export type Route = {
  name: RouteName;
  traceId?: string;
};
