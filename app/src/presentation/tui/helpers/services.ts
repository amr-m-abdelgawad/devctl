import { type DevctlConfig, type ServiceConfig } from "../../../domain/config/types.ts";
import { type Runtime, displayState } from "../../../domain/service/services.ts";
import { type PersistedState } from "../../../domain/session/session.ts";
import { Detector } from "../../../shared/redaction.ts";
import { type StatusSnapshot } from "../../../domain/status.ts";

export const SERVICE_ROW_LEAD = 8;

export const SERVICE_STATE_COL = 12;

export const SERVICE_HEALTH_COL = 10;

export const SERVICE_PORT_COL = 8;

export const SERVICE_PID_COL = 8;

export const SERVICE_UPTIME_COL = 9;

export const SERVICE_RESTARTS_COL = 6;

export const SERVICE_CPU_COL = 7;

export const SERVICE_MEM_COL = 8;

export const SERVICE_NAME_MIN = 12;

export const SERVICE_NAME_MAX = 40;

export const SERVICE_COL_GAP = 2;

export const SERVICE_NAME_PAD = 2;

export const SERVICE_PANE_BORDER = 2;

export const SERVICE_PANE_PAD = 2;

export const SERVICE_LIST_MIN = 34;

const SHOW_HEALTH_AT = 48;

const SHOW_PORT_AT = 60;

const SHOW_PID_AT = 72;

const LIST_PANE_SHARE = 0.48;

export function serviceRowShowsHealth(paneWidth: number): boolean {
  return paneWidth >= SHOW_HEALTH_AT;
}

export function serviceRowShowsPort(paneWidth: number): boolean {
  return paneWidth >= SHOW_PORT_AT;
}

export function serviceRowShowsPid(paneWidth: number): boolean {
  return paneWidth >= SHOW_PID_AT;
}

export function serviceListInnerWidth(paneWidth: number, pad = 0): number {
  return Math.max(1, paneWidth - SERVICE_PANE_BORDER - pad * 2);
}

export function serviceNameColumnWidth(paneWidth: number): number {
  let used = SERVICE_ROW_LEAD + SERVICE_STATE_COL + SERVICE_COL_GAP;
  if (serviceRowShowsHealth(paneWidth)) {
    used += SERVICE_HEALTH_COL;
  }
  if (serviceRowShowsPort(paneWidth)) {
    used += SERVICE_PORT_COL;
  }
  if (serviceRowShowsPid(paneWidth)) {
    used += SERVICE_PID_COL;
  }
  return Math.max(SERVICE_NAME_MIN, paneWidth - used);
}

export function serviceListPaneWidth(termWidth: number, names: string[], stacked: boolean): number {
  if (stacked) {
    return termWidth;
  }
  const longest = names.reduce((max, name) => Math.max(max, name.length), 0);
  const nameCol = Math.min(SERVICE_NAME_MAX, Math.max(SERVICE_NAME_MIN, longest + SERVICE_NAME_PAD));
  const wanted =
    SERVICE_ROW_LEAD + SERVICE_STATE_COL + SERVICE_COL_GAP + nameCol + SERVICE_PANE_BORDER + SERVICE_PANE_PAD;
  const cap = Math.max(SERVICE_LIST_MIN, Math.floor(termWidth * LIST_PANE_SHARE));
  return Math.min(cap, Math.max(SERVICE_LIST_MIN, wanted));
}

export function defaultProfileName(cfg?: DevctlConfig): string {
  if (!cfg) {
    return "";
  }
  const names = Object.keys(cfg.profiles).sort();
  return names[0] ?? "";
}

export function noneStarted(snap?: StatusSnapshot): boolean {
  if (!snap) {
    return true;
  }
  const runtimes = Object.values(snap.services);
  if (runtimes.length === 0) {
    return true;
  }
  return runtimes.every((rt) => rt.state === "STOPPED" || rt.state === "UNKNOWN");
}

export function canStartAll(snap?: StatusSnapshot): boolean {
  if (!snap) {
    return true;
  }
  const runtimes = Object.values(snap.services);
  if (runtimes.length === 0) {
    return true;
  }
  return !runtimes.some((rt) => isActiveRuntime(rt));
}

export function explicitServices(args: string[], checked: string[]): string[] {
  if (args.length > 0) {
    return args;
  }
  return [...checked];
}

export function focusedServices(checked: string[], focused: string): string[] {
  if (checked.length > 0) {
    return [...checked];
  }
  return focused === "" ? [] : [focused];
}

export function serviceCommandText(svc: ServiceConfig): string {
  return svc.command.args.join(" ") || "—";
}

export function servicePortsText(svc: ServiceConfig, rt?: Runtime): string {
  const live = firstPort(rt);
  if (live !== "") {
    return live;
  }
  if (svc.ports.length === 0) {
    return "—";
  }
  return svc.ports.map((port) => `${port.name}:${port.auto ? "auto" : port.value}`).join(" ");
}

export function serviceHealthText(svc: ServiceConfig): string {
  const kind = svc.health.type || "none";
  const target = svc.health.url || svc.health.address;
  return target === "" ? kind : `${kind} ${target}`;
}

export function serviceIdentityText(svc: ServiceConfig, rt?: Runtime): string {
  if (rt?.identity) {
    return rt.identity;
  }
  const kind = svc.identity.type || "none";
  const account = svc.identity.service_account;
  return account === "" ? kind : `${kind} ${account}`;
}

export function serviceRestartText(svc: ServiceConfig): string {
  const policy = svc.restart.policy || "none";
  if (svc.restart.max_retries > 0) {
    return `${policy} ×${svc.restart.max_retries}`;
  }
  return policy;
}

export type ServiceEnvEntry = {
  key: string;
  value: string;
  required: boolean;
  // Set directly in this service's own `environment.vars`/`environment.defaults`
  // — as opposed to dotenv, profile, secrets, plugin, or runtime-injected — so
  // the UI can call out what the user actually wrote in config.
  fromConfig: boolean;
};

export function serviceEnvEntries(
  svc: ServiceConfig,
  reveal: boolean,
  extraMarkers: string[],
  extraPatterns: string[],
  resolved?: Record<string, string>,
): ServiceEnvEntry[] {
  const configured = { ...svc.environment.defaults, ...svc.environment.vars };
  const merged = resolved ?? configured;
  const redacted = redactEnv(merged, reveal, extraMarkers, extraPatterns);
  const keys = new Set([...Object.keys(redacted), ...svc.environment.required]);
  return [...keys]
    .map((key) => ({
      key,
      value: redacted[key] ?? "",
      required: svc.environment.required.includes(key),
      fromConfig: Object.prototype.hasOwnProperty.call(configured, key),
    }))
    .sort((a, b) => (a.fromConfig === b.fromConfig ? a.key.localeCompare(b.key) : a.fromConfig ? -1 : 1));
}

export function previousSessionNote(leftover?: PersistedState, currentSession?: string): PersistedState | undefined {
  if (!leftover || leftover.processes.length === 0) {
    return undefined;
  }
  if (currentSession !== undefined && currentSession !== "" && leftover.session_id === currentSession) {
    return undefined;
  }
  return leftover;
}

export function firstPort(rt?: Runtime): string {
  if (!rt) {
    return "";
  }
  if (rt.ports.http !== undefined) {
    return String(rt.ports.http);
  }
  const value = Object.values(rt.ports)[0];
  return value !== undefined ? String(value) : "";
}

export function serviceLineState(rt?: Runtime): string {
  if (!rt) {
    return "STOPPED";
  }
  return displayState(rt);
}

export function redactEnv(env: Record<string, string>, reveal: boolean, extraMarkers: string[], extraPatterns: string[]): Record<string, string> {
  if (reveal) {
    return env;
  }
  return new Detector(extraMarkers, extraPatterns).redactMap(env);
}

const LIVE_PROCESS_STATES = new Set(["RUNNING", "STARTING", "RESTARTING", "HEALTHY", "UNHEALTHY"]);

export function isLiveProcessState(state: string): boolean {
  return LIVE_PROCESS_STATES.has(state);
}

export function isActiveRuntime(rt?: Runtime): boolean {
  if (!rt) {
    return false;
  }
  return isLiveProcessState(rt.state);
}

