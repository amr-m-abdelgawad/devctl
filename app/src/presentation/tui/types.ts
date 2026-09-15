export type Screen =
  | "dashboard"
  | "services"
  | "detail"
  | "logs"
  | "auth"
  | "credentials"
  | "proxy"
  | "llm"
  | "doctor"
  | "config"
  | "profiles"
  | "setup"
  | "settings"
  | "mcp"
  | "stats"
  | "httpclient";

export type SlashPicker = "commands" | "tasks" | "services";

export type Overlay =
  | "none"
  | "slash"
  | "themes"
  | "help"
  | "confirm"
  | "plan"
  | "leader"
  | "log-details"
  | "config-edit"
  | "route-details"
  | "llm-details"
  | "scroll-text"
  | "setup-wizard"
  | "trace"
  | "span-details";

export type LifecycleKind = "start" | "stop" | "restart";

export type ConfirmKind = "quit" | "start-profile" | "free-port" | "reload" | "reset-prefs" | "restart-cascade";

export type ConfirmDetail = {
  port?: number;
  pid?: number;
  process?: string;
  services?: string[];
};

export type FooterHint = {
  key: string;
  label: string;
};

/** Logs search field: closed, typing, or applied as a filter after Enter. */
export type LogSearchMode = "off" | "editing" | "applied";

export type NavItem = {
  id: Screen;
  label: string;
};
