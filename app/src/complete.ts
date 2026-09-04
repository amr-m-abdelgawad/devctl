import { type DevctlConfig } from "./config/index.ts";

const SHELLS = ["zsh", "bash", "fish"] as const;

export function completionScript(shell: string): string {
  if (shell === "zsh") {
    return `#compdef devctl
_devctl() {
  local -a opts
  local line="\${words[*]}"
  opts=(\${(f)"$(devctl __complete "$line" 2>/dev/null)"})
  _describe 'devctl' opts
}
compdef _devctl devctl
`;
  }
  if (shell === "bash") {
    return `_devctl() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local line="\${COMP_LINE}"
  local opts
  opts="$(devctl __complete "$line" 2>/dev/null)"
  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
}
complete -F _devctl devctl
`;
  }
  if (shell === "fish") {
    return `function __devctl_complete
  devctl __complete (commandline -cp)
end
complete -c devctl -f -a "(__devctl_complete)"
`;
  }
  throw new Error(`unsupported shell "${shell}"; use ${SHELLS.join(", ")}`);
}

export function completeLine(line: string, cfg: DevctlConfig): string[] {
  const parts = line.trim().split(/\s+/).filter((part) => part !== "");
  const tail = line.endsWith(" ") ? "" : (parts[parts.length - 1] ?? "");
  const words = line.endsWith(" ") ? parts : parts.slice(0, -1);
  const cmd = words[1] ?? "";
  const services = Object.keys(cfg.services).sort();
  const profiles = Object.keys(cfg.profiles).sort();
  const commands = [
    "start",
    "run",
    "exec",
    "down",
    "daemon",
    "stop",
    "restart",
    "status",
    "logs",
    "doctor",
    "setup",
    "auth",
    "proxy",
    "mcp",
    "config",
    "reload",
    "attach",
    "completion",
    "update",
    "version",
  ];
  if (cmd === "" || words.length < 2) {
    return filterPrefix(commands, tail);
  }
  if (cmd === "start" || cmd === "stop" || cmd === "restart" || cmd === "logs") {
    if (tail === "--profile" || words[words.length - 1] === "--profile") {
      return filterPrefix(profiles, tail === "--profile" ? "" : tail);
    }
    return filterPrefix([...services, "--profile", "--detach", "--json", "--since", "--until"], tail);
  }
  if (cmd === "completion") {
    return filterPrefix([...SHELLS].sort(), tail);
  }
  if (cmd === "run") return filterPrefix([...Object.keys(cfg.tasks).sort(), "--json"], tail);
  if (cmd === "exec") return filterPrefix([...services, "--print-env", "--reveal", "--json"], tail);
  if (cmd === "auth") {
    return filterPrefix(["status", "login", "logout", "refresh"], tail);
  }
  if (cmd === "config") {
    return filterPrefix(["validate", "show", "diff"], tail);
  }
  if (cmd === "proxy") {
    return filterPrefix(["status", "start", "stop"], tail);
  }
  return filterPrefix(commands, tail);
}

function filterPrefix(values: string[], prefix: string): string[] {
  if (prefix === "") {
    return values;
  }
  return values.filter((value) => value.startsWith(prefix));
}
