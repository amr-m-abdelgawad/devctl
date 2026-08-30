import { type LogEvent } from "./logs.ts";
import { type Runtime } from "./services.ts";

export type StartRequest = {
  services?: string[];
  profile?: string;
  detach?: boolean;
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
  export?: string;
};

export type RouteSnapshot = {
  name: string;
  identity: string;
  upstream: string;
  auth: string;
};

export type ProxySnapshot = {
  running: boolean;
  address?: string;
  routes?: RouteSnapshot[];
};

export type McpSnapshot = {
  running: boolean;
  address?: string;
  port?: number;
  token?: string;
};

export type IdentitySnapshot = {
  user: string;
  project: string;
  project_source: string;
  adc: boolean;
  service_accounts: Record<string, boolean>;
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
