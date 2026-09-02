import { type LogEvent } from "./logs.ts";
import { type Runtime } from "./services.ts";

export type StartRequest = {
  services?: string[];
  profile?: string;
  detach?: boolean;
  // The calling client's own OS environment, forwarded so the daemon can
  // resolve each started service's env from whichever client most recently
  // started/restarted it, rather than the daemon's own stale process.env.
  client_env?: Record<string, string>;
  // Internal only: marks a start the supervisor issued for its own
  // automatic (health-triggered) restart, as opposed to one a real client
  // asked for. A real caller should never set this — it suppresses the
  // restart-count reset a genuine start/restart request would otherwise get.
  auto?: boolean;
};

export type StopRequest = {
  services?: string[];
};

export type RestartRequest = {
  services?: string[];
};

export type LogsRequest = {
  services?: string[];
  level?: string;
  search?: string;
  regex?: boolean;
  source?: string;
  since?: string;
  until?: string;
  export?: string;
};

export type RouteSnapshot = {
  name: string;
  identity: string;
  upstream: string;
  auth: string;
};

export type ProxyRequestSnapshot = {
  timestamp: string;
  requestId: string;
  method: string;
  path: string;
  route: string;
  identity: string;
  status: number;
  durationMs: number;
  error?: string;
};

export type ProxySnapshot = {
  running: boolean;
  address?: string;
  routes?: RouteSnapshot[];
  requestTotal?: number;
  requestErrors?: number;
  recentRequests?: ProxyRequestSnapshot[];
};

export type McpSnapshot = {
  running: boolean;
  address?: string;
  port?: number;
  token?: string;
};

export type ServiceAccountStatus = "unknown" | "available" | "unavailable";

export type IdentitySnapshot = {
  user: string;
  project: string;
  project_source: string;
  adc: boolean;
  // Boolean compatibility map: present only for identities that have
  // actually been probed (never defaulted to false) — see
  // service_account_status for the full unknown/available/unavailable
  // picture, including identities nothing has probed yet.
  service_accounts: Record<string, boolean>;
  service_account_status: Record<string, ServiceAccountStatus>;
  iap: boolean;
};

export type LogSnapshot = {
  total: number;
  errors: number;
  counts: Record<string, number>;
};

export type CredentialEntrySnapshot = {
  identity: string;
  audience: string;
  expires_at: string;
  valid: boolean;
};

export type CredentialsSnapshot = {
  backend: string;
  entries: CredentialEntrySnapshot[];
};

export type ReloadResult = {
  restart_required: string[];
  changes: Record<string, string[]>;
  // Fields the running supervisor process itself cannot pick up from a
  // config reload (log capacity/persistence, auth refresh threshold, plugin
  // paths) — these need `devctl stop && devctl start`, not a service
  // restart, so they're reported separately from restart_required.
  supervisor_restart_required?: string[];
};

export type SystemSnapshot = {
  platform: string;
  cpuCount: number;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  memTotalKB: number;
  memFreeKB: number;
  memAvailableKB: number;
  hostUptimeSec: number;
};

export type StatusSnapshot = {
  session_id: string;
  repo_root: string;
  profile: string;
  services: Record<string, Runtime>;
  proxy: ProxySnapshot;
  mcp?: McpSnapshot;
  identity: IdentitySnapshot;
  credentials?: CredentialsSnapshot;
  detached?: boolean;
  logs: LogSnapshot;
  plan?: string[];
  restart_required?: string[];
  system: SystemSnapshot;
};

export type Envelope = {
  id?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: string;
  kind?: string;
  hint?: string;
  service?: string;
  event?: unknown;
};

export type LogsResponse = {
  events: LogEvent[];
};
