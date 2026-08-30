export type CommandSpec = {
  name: string;
  aliases: string[];
  desc: string;
  leader: string;
  group: string;
};

export function allCommands(): CommandSpec[] {
  return [
    { name: "start", aliases: ["up"], desc: "Start selected services or the current profile", leader: "n", group: "services" },
    { name: "stop", aliases: ["down"], desc: "Stop selected services", leader: "x", group: "services" },
    { name: "restart", aliases: [], desc: "Restart selected services", leader: "R", group: "services" },
    { name: "services", aliases: ["s"], desc: "Open the services screen", leader: "s", group: "nav" },
    { name: "logs", aliases: ["l"], desc: "Open the log viewer", leader: "l", group: "nav" },
    { name: "auth", aliases: ["identity", "a"], desc: "Open identity (no tokens)", leader: "a", group: "nav" },
    { name: "credentials", aliases: ["creds"], desc: "Open credential store status", leader: "", group: "nav" },
    { name: "reload", aliases: [], desc: "Reload configuration", leader: "", group: "ui" },
    { name: "proxy", aliases: ["p"], desc: "Open the proxy screen", leader: "p", group: "nav" },
    { name: "mcp", aliases: ["agent"], desc: "Open the MCP server screen for coding agents", leader: "", group: "nav" },
    { name: "doctor", aliases: ["d"], desc: "Run environment diagnostics", leader: "d", group: "nav" },
    { name: "stats", aliases: ["metrics"], desc: "View system and service statistics", leader: "m", group: "nav" },
    { name: "config", aliases: ["c"], desc: "View merged configuration", leader: "c", group: "nav" },
    { name: "profiles", aliases: ["o"], desc: "Select a development profile", leader: "o", group: "nav" },
    { name: "setup", aliases: ["init"], desc: "Open setup guidance", leader: "i", group: "nav" },
    { name: "dashboard", aliases: ["home"], desc: "Return to the dashboard", leader: "h", group: "nav" },
    { name: "themes", aliases: ["theme"], desc: "List available themes", leader: "t", group: "ui" },
    { name: "settings", aliases: ["prefs", "preferences"], desc: "Open TUI settings (theme, mouse, MCP page)", leader: "", group: "ui" },
    { name: "help", aliases: ["?"], desc: "Show the help dialog", leader: "", group: "ui" },
    { name: "refresh", aliases: [], desc: "Refresh status and logs", leader: "r", group: "ui" },
    { name: "regex", aliases: [], desc: "Toggle regex log search", leader: "", group: "logs" },
    { name: "since", aliases: [], desc: "Filter logs after an ISO timestamp", leader: "", group: "logs" },
    { name: "history", aliases: [], desc: "Load a persisted log session", leader: "", group: "logs" },
    { name: "edit", aliases: [], desc: "Open configuration in $EDITOR", leader: "", group: "ui" },
    { name: "pause", aliases: [], desc: "Pause or resume live logs", leader: "", group: "logs" },
    { name: "fullscreen", aliases: ["zen", "expand"], desc: "Expand logs to fill the terminal", leader: "z", group: "logs" },
    { name: "filter", aliases: [], desc: "Toggle ERROR+ log filter", leader: "", group: "logs" },
    { name: "reveal", aliases: [], desc: "Reveal or hide secret environment values", leader: "", group: "ui" },
    { name: "wrap", aliases: [], desc: "Cycle log wrap: selected, all lines, or clip", leader: "", group: "logs" },
    { name: "copy", aliases: [], desc: "Copy visible logs to the clipboard", leader: "", group: "logs" },
    { name: "export", aliases: [], desc: "Write filtered logs to ~/.devctl/exports", leader: "e", group: "logs" },
    { name: "exports", aliases: ["open-exports"], desc: "Open the log export folder", leader: "", group: "logs" },
    { name: "clear", aliases: ["new"], desc: "Clear the on-screen log buffer", leader: "", group: "logs" },
    { name: "version", aliases: ["v"], desc: "Show the current devctl version", leader: "", group: "app" },
    { name: "exit", aliases: ["quit", "q"], desc: "Exit", leader: "q", group: "app" },
  ];
}

export function filterCommands(query: string): CommandSpec[] {
  const q = query.trim().toLowerCase().replace(/^\//, "");
  return allCommands().filter((c) => q === "" || commandMatch(c, q));
}

export function commandMatch(c: CommandSpec, q: string): boolean {
  if (c.name.startsWith(q) || c.name.includes(q) || c.desc.toLowerCase().includes(q)) {
    return true;
  }
  return c.aliases.some((a) => a.startsWith(q) || a === q);
}

export function lookupCommand(name: string): CommandSpec | undefined {
  const n = name.trim().toLowerCase().replace(/^\//, "").split(" ")[0] ?? "";
  return allCommands().find((c) => c.name === n || c.aliases.includes(n));
}

export function commandArgs(line: string): string[] {
  const parts = line.trim().replace(/^\//, "").split(/\s+/);
  return parts.slice(1).filter((p) => p !== "");
}

export function leaderAction(key: string): string {
  const found = allCommands().find((c) => c.leader === key);
  return found?.name ?? "";
}
