export const knownTopLevel = [
  "version",
  "project",
  "google",
  "profiles",
  "templates",
  "services",
  "tasks",
  "proxy",
  "logs",
  "auth",
  "shutdown",
  "ui",
  "secrets",
  "doctor",
  "plugins",
  "environment",
];

export const knownService = [
  "extends",
  "description",
  "command",
  "shell",
  "working_dir",
  "dependencies",
  "ports",
  "environment",
  "health",
  "identity",
  "logs",
  "restart",
  "startup",
  "capabilities",
  "proxy",
  "container",
  "hooks",
];

export const knownHealth = ["type", "url", "address", "command", "interval_seconds", "timeout_seconds", "start_period_seconds", "unhealthy_threshold", "healthy_reset_threshold"];
export const knownDependency = ["service", "condition"];
export const knownIdentity = ["type", "mode", "service_account", "config"];
export const knownRestart = ["enabled", "policy", "max_retries", "backoff_seconds"];
export const knownStartup = ["wait_for_healthy", "timeout_seconds"];
export const knownProxy = ["enabled", "listen", "token_endpoint", "routes"];
export const knownListen = ["host", "port"];
export const knownRoute = ["name", "match", "upstream", "auth"];
export const knownMatch = ["host", "path"];
export const knownUpstream = ["url"];
export const knownRouteAuth = ["type", "identity", "audience", "service_account"];
export const knownLogs = ["max_memory_events", "persistence"];
export const knownPersistence = ["enabled", "directory", "retention_days", "max_session_logs"];
export const knownAuth = ["refresh_threshold_seconds"];
export const knownShutdown = ["stop_services_on_exit", "grace_seconds"];
export const knownUI = ["theme", "keymap"];
export const knownProject = ["name"];
export const knownGoogle = ["project_id", "region"];
export const knownProfile = ["services", "environment"];
export const knownEnvStructured = ["required", "defaults"];
export const knownServiceLogs = ["stdout", "stderr"];
export const knownSecrets = ["extra_markers", "extra_patterns"];
export const knownDoctor = ["tools"];
export const knownTool = ["name", "command"];
export const knownTokenEndpoint = ["enabled", "host", "port"];
export const knownPlugin = ["path"];
export const knownProjectEnvironment = ["sources", "secrets"];
export const knownContainer = ["image", "runtime", "ports", "env", "volumes"];
export const knownHooks = ["pre_start", "post_start"];
export const knownTask = ["command", "shell", "working_dir", "dependencies", "environment"];

export const knownCapabilities = ["google", "google_api", "iap", "network", "service_identity", "local_http"];

export const SHELL_META_TOKENS = ["|", "||", "&&", ";", ">", ">>", "<", "&"];
