// Reverses newSessionID()'s format to recover the moment the session
// started, so uptime can be derived from session_id alone with no new
// persisted state.
export function sessionStartedAt(sessionID: string): Date | undefined {
  const zIndex = sessionID.indexOf("Z-");
  const stamp = zIndex >= 0 ? sessionID.slice(0, zIndex + 1) : sessionID;
  const tIndex = stamp.indexOf("T");
  if (tIndex < 0 || !stamp.endsWith("Z")) {
    return undefined;
  }
  const datePart = stamp.slice(0, tIndex);
  const timePart = stamp.slice(tIndex + 1, -1).replace(/-/g, ":");
  const parsed = new Date(`${datePart}T${timePart}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export type PersistedProcess = {
  name: string;
  pid: number;
  command: string[];
  cwd: string;
  startTime: string;
  ports: Record<string, number>;
  profile?: string;
  env?: string;
};

export type PersistedState = {
  session_id: string;
  repo_root: string;
  profile: string;
  processes: PersistedProcess[];
  // Per-service selected named environment. Survives daemon replacement so
  // a TUI/CLI switch is not lost the way client_env is.
  service_environments?: Record<string, string>;
  // Session-selected config overlay (`.devctl/overlays/<name>.yaml`). Sticky
  // like `profile` — omitting `--overlay` on a later start keeps this name.
  config_overlay?: string;
};

