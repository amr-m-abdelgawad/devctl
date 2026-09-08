import { commandSearchToken, type CommandSpec, filterCommands } from "../commands.ts";
import { defaultCopyKeybind, displayKeybind, displayWithMod } from "../tui-config.ts";
import { type FooterHint, type Overlay, type Screen } from "../types.ts";
import { NAV_CYCLE } from "./navigation.ts";

function navCycleScreen(current: Screen): Screen {
  return current === "detail" ? "services" : current;
}

export function nextScreen(current: Screen): Screen {
  const idx = NAV_CYCLE.indexOf(navCycleScreen(current));
  if (idx < 0) {
    return "dashboard";
  }
  return NAV_CYCLE[(idx + 1) % NAV_CYCLE.length] ?? "dashboard";
}

export function prevScreen(current: Screen): Screen {
  const idx = NAV_CYCLE.indexOf(navCycleScreen(current));
  if (idx < 0) {
    return "dashboard";
  }
  return NAV_CYCLE[(idx - 1 + NAV_CYCLE.length) % NAV_CYCLE.length] ?? "dashboard";
}

export function groupedCommands(commands: CommandSpec[]): { group: string; items: CommandSpec[] }[] {
  const order = ["services", "nav", "logs", "ui", "app", "tasks"];
  return order.flatMap((group) => {
    const items = commands.filter((c) => c.group === group);
    if (items.length === 0) {
      return [];
    }
    return [{ group, items }];
  });
}

export function paletteOptions(query: string): CommandSpec[] {
  const hits = filterCommands(query);
  if (commandSearchToken(query) === "") {
    return groupedCommands(hits).flatMap((group) => group.items);
  }
  return hits;
}

export function namedPickerItems(names: string[], query: string, group: "tasks" | "services", desc: string): CommandSpec[] {
  const q = commandSearchToken(query);
  const specs = [...names]
    .sort()
    .map((name) => ({ name, aliases: [] as string[], desc, leader: "", group }));
  if (q === "") {
    return specs;
  }
  return specs.filter((spec) => spec.name.toLowerCase().includes(q));
}

export function commandSelectOptions(items: CommandSpec[]): { name: string; description: string; value: string }[] {
  return groupedCommands(items).flatMap((group) =>
    group.items.map((cmd) => ({
      name: `/${cmd.name}`,
      description: `${group.group} · ${cmd.desc}`,
      value: cmd.name,
    })),
  );
}

export function footerHints(screen: Screen, overlay: Overlay, copyKey = defaultCopyKeybind()): FooterHint[] {
  if (overlay === "slash") {
    return [
      { key: "↑↓", label: "suggest" },
      { key: "tab", label: "complete" },
      { key: "enter", label: "run" },
      { key: "esc", label: "cancel" },
    ];
  }
  if (overlay === "themes") {
    return [
      { key: "↑↓", label: "move" },
      { key: "enter", label: "save" },
      { key: "esc", label: "revert" },
    ];
  }
  if (overlay === "help") {
    return [
      { key: "j/k", label: "scroll" },
      { key: "esc", label: "close" },
    ];
  }
  if (overlay === "log-details" || overlay === "scroll-text") {
    return [
      { key: "j/k", label: "scroll" },
      { key: displayKeybind(copyKey), label: "copy" },
      { key: "esc", label: "close" },
    ];
  }
  if (overlay === "confirm") {
    return [
      { key: "enter", label: "confirm" },
      { key: "esc", label: "stay" },
    ];
  }
  if (overlay === "plan") {
    return [
      { key: "esc", label: "back to dashboard" },
      { key: "enter", label: "done" },
    ];
  }
  if (overlay === "leader") {
    return leaderHints();
  }
  if (overlay === "config-edit") {
    return [
      { key: displayWithMod("s"), label: "save" },
      { key: "esc", label: "discard" },
    ];
  }
  return screenHints(screen, copyKey);
}

export function leaderHints(): FooterHint[] {
  return [
    { key: "n", label: "start" },
    { key: "x", label: "stop" },
    { key: "R", label: "restart" },
    { key: "s", label: "services" },
    { key: "l", label: "logs" },
    { key: "t", label: "themes" },
    { key: "q", label: "quit" },
  ];
}

function screenHints(screen: Screen, copyKey: string): FooterHint[] {
  const common: FooterHint[] = [
    { key: displayKeybind(copyKey), label: "copy" },
    { key: "/", label: "command" },
    { key: "?", label: "help" },
  ];
  switch (screen) {
    case "dashboard":
      return [
        { key: "space", label: "select" },
        { key: "*", label: "all" },
        { key: "-", label: "none" },
        { key: "enter", label: "start or open" },
        { key: "n", label: "start" },
        { key: "x", label: "stop" },
        { key: "r", label: "refresh" },
        { key: "R", label: "restart" },
        { key: "←→", label: "log filter" },
        { key: "g", label: "latest" },
        { key: "z", label: "full logs" },
        { key: "i", label: "internal logs" },
        { key: displayWithMod("l"), label: "clear logs" },
        { key: "j/k", label: "move" },
        ...common,
      ];
    case "services":
      return [
        { key: "enter", label: "detail" },
        { key: "space", label: "select" },
        { key: "*", label: "all" },
        { key: "-", label: "none" },
        { key: "n", label: "start" },
        { key: "x", label: "stop" },
        { key: "r", label: "refresh" },
        { key: "R", label: "restart" },
        ...common,
      ];
    case "detail":
      return [{ key: "j/k", label: "scroll env" }, { key: "n", label: "start" }, { key: "x", label: "stop" }, { key: "o", label: "config" }, { key: "l", label: "logs" }, { key: "esc", label: "back" }, ...common];
    case "logs":
      return [
        { key: "←→", label: "filter" },
        { key: "e", label: "errors" },
        { key: "i", label: "internal logs" },
        { key: displayWithMod("l"), label: "clear logs" },
        { key: "g", label: "latest" },
        { key: "f", label: "search" },
        { key: "t", label: "time" },
        { key: "m", label: "meta" },
        { key: "w", label: "wrap" },
        { key: "j/k", label: "move" },
        { key: "p", label: "pause" },
        { key: "z", label: "full screen" },
        { key: "\\", label: "split" },
        { key: "/exports", label: "open folder" },
        ...common,
      ];
    case "profiles":
      return [{ key: "space", label: "set current" }, { key: "enter", label: "set and start" }, { key: "j/k", label: "move" }, ...common];
    case "proxy":
      return [{ key: "n", label: "start proxy" }, { key: "x", label: "stop proxy" }, ...common];
    case "mcp":
      return [
        { key: "j/k", label: "move" },
        { key: "space", label: "start or copy" },
        { key: "←→", label: "change port" },
        { key: "enter", label: "start or copy" },
        ...common,
      ];
    case "config":
      return [{ key: "enter", label: "run task" }, { key: "v", label: "buffer" }, { key: "e", label: "editor" }, { key: "/diff", label: "sources" }, { key: "/reload", label: "reload" }, { key: "j/k", label: "scroll or select task" }, ...common];
    case "setup":
      return [{ key: "j/k", label: "steps" }, { key: "enter", label: "continue" }, { key: "esc", label: "back" }, { key: "esc×2", label: "quit" }, ...common];
    case "doctor":
      return [{ key: "r", label: "run doctor again" }, { key: "j/k", label: "move" }, { key: "enter", label: "fix port" }, ...common];
    case "auth":
      return [
        { key: "r", label: "probe identities" },
        { key: "/auth login", label: "ADC login" },
        { key: "/auth logout", label: "revoke ADC" },
        { key: "/auth refresh", label: "probe" },
        ...common,
      ];
    case "settings":
      return [
        { key: "j/k", label: "move" },
        { key: "←→", label: "save" },
        { key: "enter", label: "apply or open page" },
        { key: "space", label: "toggle" },
        ...common,
      ];
    default:
      return [{ key: "tab", label: "screens" }, ...common];
  }
}

export function slashWindowStart(selected: number, size: number, total: number): number {
  if (total <= size || selected < size) {
    return 0;
  }
  return Math.min(selected - size + 1, total - size);
}

function slashVisualRows(items: CommandSpec[], from: number, to: number): number {
  const slice = items.slice(from, to + 1);
  const groups = new Set(slice.map((cmd) => cmd.group));
  return slice.length + groups.size;
}

/** Slice commands so group headers plus rows stay within `maxVisualRows`. */
export function slashWindowItems(items: CommandSpec[], selected: number, maxVisualRows: number): CommandSpec[] {
  if (items.length === 0) {
    return [];
  }
  const idx = Math.min(Math.max(selected, 0), items.length - 1);
  let start = idx;
  let end = idx;
  for (;;) {
    const growEnd = end + 1 < items.length && slashVisualRows(items, start, end + 1) <= maxVisualRows;
    const growStart = start > 0 && slashVisualRows(items, start - 1, end) <= maxVisualRows;
    if (growEnd) {
      end += 1;
    } else if (growStart) {
      start -= 1;
    } else {
      break;
    }
  }
  return items.slice(start, end + 1);
}

export function selectedSlashCommand<T>(items: T[], index: number): T | undefined {
  if (items.length === 0) {
    return undefined;
  }
  const clamped = Math.min(Math.max(index, 0), items.length - 1);
  return items[clamped];
}
