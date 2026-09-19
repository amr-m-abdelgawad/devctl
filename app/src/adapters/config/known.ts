export const knownTopLevel = [
  "version",
  "project",
  "google",
  "profiles",
  "templates",
  "services",
  "tasks",
  "http",
  "proxy",
  "logs",
  "auth",
  "shutdown",
  "ui",
  "secrets",
  "doctor",
  "plugins",
  "environment",
  "telemetry",
  "web",
  "llm",
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
  "environments",
  "default_environment",
  "health",
  "identity",
  "logs",
  "restart",
  "startup",
  "capabilities",
  "proxy",
  "expose",
  "container",
  "watch",
  "hooks",
];

export const knownHealth = ["type", "url", "address", "grpc_service", "command", "interval_seconds", "timeout_seconds", "start_period_seconds", "unhealthy_threshold", "healthy_reset_threshold"];
export const knownDependency = ["service", "condition"];
export const knownIdentity = ["type", "mode", "service_account", "config"];
export const knownRestart = ["enabled", "policy", "max_retries", "backoff_seconds"];
export const knownStartup = ["wait_for_healthy", "timeout_seconds"];
export const knownExpose = ["enabled", "host", "port"];
export const knownProxy = ["enabled", "gateway", "credentials", "listen", "token_endpoint", "routes"];
export const knownListen = ["host", "port"];
export const knownRoute = ["name", "transport", "listen", "match", "upstream", "auth", "response_headers", "inspect", "strip_prefix", "log"];
export const knownRouteInspect = ["enabled", "max_bytes"];
export const knownRouteLog = ["grpc"];
export const knownRouteLogGrpc = ["ok"];
export const knownRouteLogGrpcOk = ["status", "methods", "log"];
export const knownMatch = ["host", "path"];
export const knownUpstream = ["url", "service", "port", "recipe"];
export const knownRouteAuth = ["type", "identity", "audience", "service_account", "client_id", "client_secret", "credentials", "headers"];
export const knownLogs = ["max_memory_events", "persistence"];
export const knownPersistence = ["enabled", "directory", "retention_days", "max_session_logs"];
export const knownAuth = ["refresh_threshold_seconds"];
export const knownShutdown = ["stop_services_on_exit", "grace_seconds"];
export const knownUI = ["theme", "keymap"];
export const knownProject = ["name"];
export const knownGoogle = ["project_id", "region"];
export const knownProfile = ["services", "environment", "environments", "service_environment"];
export const knownEnvStructured = ["required", "defaults"];
export const knownServiceLogs = ["stdout", "stderr", "multiline"];
export const knownServiceLogMultiline = ["start", "continuation", "max_wait_ms", "max_lines"];
export const knownSecrets = ["extra_markers", "extra_patterns"];
export const knownDoctor = ["tools"];
export const knownTool = ["name", "command"];
export const knownTokenEndpoint = ["enabled", "host", "port"];
export const knownPlugin = ["path"];
export const knownProjectEnvironment = ["sources", "secrets"];
export const knownContainer = ["image", "runtime", "ports", "env", "volumes", "user", "memory", "cpus", "read_only", "cap_drop", "pids_limit"];
export const knownWatch = ["enabled", "paths", "debounce_ms", "ignore"];
export const knownHooks = ["pre_start", "post_start"];
export const knownTask = ["command", "shell", "working_dir", "dependencies", "environment"];
export const knownHttp = ["request", "outputs", "cache", "expose"];
export const knownHttpRequest = ["method", "url", "headers", "body", "form", "auth", "timeout_seconds"];
export const knownHttpCache = ["jwt", "expires_in"];
export const knownHttpExpose = ["enabled", "host", "response_headers", "allow_token_body"];
export const knownTelemetry = ["otlp"];
export const knownTelemetryOtlp = ["enabled", "listen"];
export const knownWeb = ["enabled", "listen"];
export const knownLlm = ["enabled", "sources"];
export const knownLlmSource = [
  "name",
  "type",
  "service",
  "port",
  "endpoint",
  "path_prefix",
  "headers",
  "via",
  "management_endpoint",
  "management_service",
  "management_port",
  "auth",
  "capture",
  "poll_seconds",
];
export const knownLlmAuth = ["type", "token_env", "header"];
export const knownLlmVia = ["route"];
export const knownLlmCapture = ["prompts", "max_bytes", "paths"];

export const knownCapabilities = ["google", "google_api", "iap", "network", "service_identity", "local_http"];

export const SHELL_META_TOKENS = ["|", "||", "&&", ";", ">", ">>", "<", "&"];
