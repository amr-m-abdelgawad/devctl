export type Screen =
  | "dashboard"
  | "services"
  | "detail"
  | "logs"
  | "auth"
  | "credentials"
  | "proxy"
  | "doctor"
  | "config"
  | "profiles"
  | "setup"
  | "settings"
  | "mcp"
  | "stats";

export type Overlay = "none" | "slash" | "palette" | "themes" | "help" | "confirm" | "plan" | "leader" | "log-details" | "config-edit" | "route-details";

export type LifecycleKind = "start" | "stop" | "restart";

export type ConfirmKind = "quit" | "start-profile" | "free-port" | "reload" | "reset-prefs";

export type ConfirmDetail = {
  port?: number;
  pid?: number;
  process?: string;
};

export type FooterHint = {
  key: string;
  label: string;
};

export type NavItem = {
  id: Screen;
  label: string;
};
