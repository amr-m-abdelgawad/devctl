import type { PortHolder } from "../net/ports.ts";

export type Severity = "ok" | "warn" | "error";

export type PortAction = {
  kind: "free-port";
  holder: PortHolder;
};

export type Check = {
  name: string;
  severity: Severity;
  message: string;
  hint?: string;
  action?: PortAction;
};

export type Report = {
  checks: Check[];
  issues: number;
};

export type DoctorProgress = {
  active: string;
  checks: Check[];
};

export type DoctorRuntimeContext = {
  services?: Record<string, { pid: number; ports: Record<string, number>; state?: string }>;
  proxyRunning?: boolean;
  // An attached TUI operates on the daemon's last-known-good config snapshot,
  // but this one check must describe the file currently on disk. Supplying an
  // empty string means the local file parsed successfully; a non-empty value
  // is the local parse error. Other doctor checks still use cfg/the snapshot.
  repositoryConfigError?: string;
};
