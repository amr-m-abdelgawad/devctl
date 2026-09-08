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
    { name: "stop", aliases: [], desc: "Stop selected services", leader: "x", group: "services" },
    { name: "restart", aliases: [], desc: "Restart selected services (/restart --cascade also restarts dependents)", leader: "R", group: "services" },
    { name: "run", aliases: ["task"], desc: "Run a one-off task; empty /run opens a picker", leader: "", group: "services" },
    { name: "exec", aliases: [], desc: "Run a command in a service context; empty /exec opens a picker", leader: "", group: "services" },
    { name: "services", aliases: ["s"], desc: "Open the services screen", leader: "s", group: "nav" },
    { name: "logs", aliases: ["l"], desc: "Open the log viewer", leader: "l", group: "nav" },
    { name: "auth", aliases: ["identity", "a"], desc: "Open identity; /auth login, logout, or refresh", leader: "a", group: "nav" },
    { name: "credentials", aliases: ["creds"], desc: "Open credential store status", leader: "", group: "nav" },
    { name: "reload", aliases: [], desc: "Reload configuration", leader: "", group: "ui" },
    { name: "proxy", aliases: ["p"], desc: "Open the proxy screen", leader: "p", group: "nav" },
    { name: "mcp", aliases: ["agent"], desc: "Open the MCP server screen for coding agents", leader: "", group: "nav" },
    { name: "doctor", aliases: ["d"], desc: "Run environment diagnostics", leader: "d", group: "nav" },
    { name: "stats", aliases: ["metrics"], desc: "View system and service statistics", leader: "m", group: "nav" },
    { name: "config", aliases: ["c"], desc: "View merged configuration", leader: "c", group: "nav" },
    { name: "import", aliases: [], desc: "Preview or write a Compose mapping: /import compose [path] [--write]", leader: "", group: "ui" },
    { name: "diff", aliases: ["provenance"], desc: "Show winning config sources and what they shadowed", leader: "", group: "ui" },
    { name: "daemon", aliases: ["bootstrap"], desc: "Show supervisor bootstrap logs (same file as devctl daemon logs)", leader: "", group: "app" },
    { name: "update", aliases: [], desc: "Install a newer GitHub Release when the install method is known", leader: "", group: "app" },
    { name: "profiles", aliases: ["o"], desc: "Select a development profile", leader: "o", group: "nav" },
    { name: "setup", aliases: ["init"], desc: "Open setup guidance", leader: "i", group: "nav" },
    { name: "dashboard", aliases: ["home"], desc: "Return to the dashboard", leader: "h", group: "nav" },
    { name: "themes", aliases: ["theme"], desc: "List available themes", leader: "t", group: "ui" },
    { name: "settings", aliases: ["prefs", "preferences"], desc: "Open TUI settings (theme, mouse, MCP page)", leader: "", group: "ui" },
    { name: "help", aliases: ["?"], desc: "Show the help dialog", leader: "", group: "ui" },
    { name: "refresh", aliases: [], desc: "Refresh status and logs", leader: "r", group: "ui" },
    { name: "regex", aliases: [], desc: "Toggle regex log search", leader: "", group: "logs" },
    { name: "since", aliases: [], desc: "Filter logs after an ISO timestamp", leader: "", group: "logs" },
    { name: "until", aliases: [], desc: "Filter logs before an ISO timestamp", leader: "", group: "logs" },
    { name: "history", aliases: [], desc: "Load a persisted log session", leader: "", group: "logs" },
    { name: "edit", aliases: [], desc: "Open configuration in $EDITOR", leader: "", group: "ui" },
    { name: "buffer", aliases: [], desc: "Edit configuration in a validate/save buffer", leader: "", group: "ui" },
    { name: "pause", aliases: [], desc: "Pause or resume live logs", leader: "", group: "logs" },
    { name: "fullscreen", aliases: ["zen", "expand"], desc: "Expand logs to fill the terminal", leader: "z", group: "logs" },
    { name: "split", aliases: [], desc: "Split the logs screen into two service panes", leader: "", group: "logs" },
    { name: "trace", aliases: [], desc: "Search logs for a request or trace id", leader: "", group: "logs" },
    { name: "filter", aliases: [], desc: "Toggle ERROR+ log filter", leader: "", group: "logs" },
    { name: "system", aliases: ["internal"], desc: "Show or hide internal auth/mcp/devctl/proxy logs", leader: "", group: "logs" },
    { name: "reveal", aliases: [], desc: "Reveal or hide secret environment values", leader: "", group: "ui" },
    { name: "wrap", aliases: [], desc: "Cycle log wrap: selected, all lines, or clip", leader: "", group: "logs" },
    { name: "copy", aliases: [], desc: "Copy visible logs to the clipboard", leader: "", group: "logs" },
    { name: "export", aliases: [], desc: "Write filtered logs to ~/.devctl/exports", leader: "e", group: "logs" },
    { name: "exports", aliases: ["open-exports"], desc: "Open the log export folder", leader: "", group: "logs" },
    { name: "clear", aliases: ["new"], desc: "Clear the on-screen log buffer", leader: "", group: "logs" },
    { name: "version", aliases: ["v"], desc: "Show the current devctl version", leader: "", group: "app" },
    { name: "down", aliases: [], desc: "Stop the supervisor; --keep-services leaves processes running", leader: "", group: "app" },
    { name: "exit", aliases: ["quit", "q"], desc: "Exit (detach or stop services)", leader: "q", group: "app" },
  ];
}

const SCORE_EXACT_NAME = 100;
const SCORE_EXACT_ALIAS = 90;
const SCORE_NAME_PREFIX = 80;
const SCORE_ALIAS_PREFIX = 70;
const SCORE_NAME_PART = 60;
const SCORE_NAME_CONTAINS = 50;
const SCORE_ALIAS_CONTAINS = 45;
const SCORE_FUZZY_NAME = 30;
const SCORE_FUZZY_ALIAS = 28;
const SCORE_DESC_WORD = 20;
const SCORE_DESC_CONTAINS = 10;
const MIN_CONTAINS_QUERY = 2;
const MIN_FUZZY_QUERY = 3;
const MIN_DESC_QUERY = 4;
const MIN_DESC_WORD = 4;
const MIN_DESC_INCLUDES = 4;
const FUZZY_SCORE_CAP = 9;

/** Command token only — `/start api` still searches `start`. */
export function commandSearchToken(query: string): string {
  const q = query.trim().toLowerCase().replace(/^\//, "");
  const space = q.indexOf(" ");
  return space === -1 ? q : q.slice(0, space);
}

export function filterCommands(query: string): CommandSpec[] {
  const q = commandSearchToken(query);
  if (q === "") {
    return allCommands();
  }
  return allCommands()
    .map((command) => ({ command, score: commandScore(command, q) }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.command.name.localeCompare(right.command.name))
    .map((row) => row.command);
}

function commandScore(command: CommandSpec, q: string): number {
  if (q === "") {
    return 1;
  }
  const name = command.name.toLowerCase();
  const aliases = command.aliases.map((alias) => alias.toLowerCase());
  return (
    exactScore(name, aliases, q) ||
    prefixScore(name, aliases, q) ||
    containsScore(name, aliases, q) ||
    fuzzyScore(name, aliases, q) ||
    descScore(command.desc.toLowerCase(), q)
  );
}

function exactScore(name: string, aliases: string[], q: string): number {
  if (name === q) {
    return SCORE_EXACT_NAME;
  }
  return aliases.includes(q) ? SCORE_EXACT_ALIAS : 0;
}

function prefixScore(name: string, aliases: string[], q: string): number {
  if (name.startsWith(q)) {
    return SCORE_NAME_PREFIX;
  }
  if (aliases.some((alias) => alias.startsWith(q))) {
    return SCORE_ALIAS_PREFIX;
  }
  const parts = name.split("-");
  const partHit = parts.length > 1 && parts.some((part) => part.startsWith(q));
  return partHit ? SCORE_NAME_PART : 0;
}

function containsScore(name: string, aliases: string[], q: string): number {
  if (q.length < MIN_CONTAINS_QUERY) {
    return 0;
  }
  if (name.includes(q)) {
    return SCORE_NAME_CONTAINS;
  }
  return aliases.some((alias) => alias.includes(q)) ? SCORE_ALIAS_CONTAINS : 0;
}

function fuzzyScore(name: string, aliases: string[], q: string): number {
  if (q.length < MIN_FUZZY_QUERY) {
    return 0;
  }
  const nameFuzzy = subsequenceScore(name, q);
  if (nameFuzzy > 0) {
    return SCORE_FUZZY_NAME + Math.min(nameFuzzy, FUZZY_SCORE_CAP);
  }
  return aliases.some((alias) => subsequenceScore(alias, q) > 0) ? SCORE_FUZZY_ALIAS : 0;
}

function subsequenceScore(text: string, q: string): number {
  let from = 0;
  let consecutive = 0;
  let points = 0;
  for (let i = 0; i < q.length; i += 1) {
    const ch = q[i];
    if (ch === undefined) {
      return 0;
    }
    const at = text.indexOf(ch, from);
    if (at < 0) {
      return 0;
    }
    if (from > 0 && at === from) {
      consecutive += 1;
      points += 2 + consecutive;
    } else {
      consecutive = 0;
      points += at === 0 ? 4 : 1;
    }
    from = at + 1;
  }
  return points;
}

function descScore(desc: string, q: string): number {
  if (q.length < MIN_DESC_QUERY) {
    return 0;
  }
  const words = desc.split(/[^a-z0-9+]+/).filter((word) => word.length >= MIN_DESC_WORD);
  if (words.some((word) => word.startsWith(q))) {
    return SCORE_DESC_WORD;
  }
  return q.length >= MIN_DESC_INCLUDES && desc.includes(q) ? SCORE_DESC_CONTAINS : 0;
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

export type ExecSlashArgs = {
  service: string;
  printEnv: boolean;
  reveal: boolean;
  command: string[];
};

export function parseRestartArgs(args: string[]): { services: string[]; cascade: boolean } {
  const cascade = args.includes("--cascade") || args.includes("-c");
  const services = args.filter((a) => a !== "--cascade" && a !== "-c");
  return { services, cascade };
}

export function parseExecArgs(args: string[]): ExecSlashArgs {
  const printEnv = args.includes("--print-env");
  const reveal = args.includes("--reveal");
  const rest = args.filter((a) => a !== "--print-env" && a !== "--reveal" && a !== "--");
  return { service: rest[0] ?? "", printEnv, reveal, command: rest.slice(1) };
}
