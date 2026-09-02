import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { defaultCopyKeybind, keyMatches, loadTuiConfig, mergeTuiConfig, defaultTuiConfig, parseJsonc, parseKeybind, resolveTuiOverridePath, saveTuiPreferences, userTuiConfigPath } from "./tui-config.ts";

describe("tui.json", () => {
  test("parses jsonc and merges keybinds with defaults", () => {
    const raw = parseJsonc(`{
      // comment
      "theme": "tokyonight",
      "leader_timeout": 1500,
      "keybinds": { "leader": "ctrl+z" }
    }`);
    const cfg = mergeTuiConfig(defaultTuiConfig(), raw, "/tmp/tui.json");
    expect(cfg.theme).toBe("tokyonight");
    expect(cfg.leader_timeout).toBe(1500);
    expect(cfg.keybinds.leader).toBe("ctrl+z");
    expect(cfg.keybinds.command_list).toBe("ctrl+p");
    expect(cfg.keybinds.quit).toBe("q");
    expect(cfg.keybinds.restart).toBe("R");
    expect(cfg.keybinds.refresh).toBe("r");
    expect(cfg.keybinds.services).toBe("s");
    expect(defaultTuiConfig().keybinds.config).toBe("c");
    expect(defaultTuiConfig().keybinds.setup).toBe("u");
    expect(cfg.mouse).toBe(true);
    expect(cfg.mcp_enabled).toBe(false);
  });

  test("merges mcp_enabled and mcp_port", () => {
    const cfg = mergeTuiConfig(defaultTuiConfig(), { mcp_enabled: true, mcp_port: 18721 }, "/tmp/tui.json");
    expect(cfg.mcp_enabled).toBe(true);
    expect(cfg.mcp_port).toBe(18721);
  });

  test("loads DEVCTL_TUI_CONFIG override", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-tui-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "custom.jsonc");
    writeFileSync(path, `{ "theme": "nord", "mouse": false }`);
    const prev = process.env.DEVCTL_TUI_CONFIG;
    process.env.DEVCTL_TUI_CONFIG = path;
    try {
      const cfg = loadTuiConfig(dir);
      expect(cfg.theme).toBe("nord");
      expect(cfg.mouse).toBe(false);
      expect(cfg.path).toBe(path);
    } finally {
      if (prev === undefined) {
        delete process.env.DEVCTL_TUI_CONFIG;
      } else {
        process.env.DEVCTL_TUI_CONFIG = prev;
      }
    }
  });

  test("saves theme into the user profile tui.json", () => {
    const prevHome = process.env.DEVCTL_HOME;
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-home-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    process.env.DEVCTL_HOME = dir;
    try {
      const path = saveTuiPreferences({ theme: "gruvbox", mouse: false, leader_timeout: 3000, font_size: 18 });
      expect(path).toBe(userTuiConfigPath());
      const cfg = loadTuiConfig(dir);
      expect(cfg.theme).toBe("gruvbox");
      expect(cfg.mouse).toBe(false);
      expect(cfg.leader_timeout).toBe(3000);
      expect(cfg.font_size).toBe(18);
    } finally {
      if (prevHome === undefined) {
        delete process.env.DEVCTL_HOME;
      } else {
        process.env.DEVCTL_HOME = prevHome;
      }
    }
  });

  test("matches leader and palette keybinds", () => {
    expect(parseKeybind("ctrl+x")[0]?.ctrl).toBe(true);
    expect(parseKeybind("ctrl+x")[0]?.name).toBe("x");
    expect(keyMatches({ name: "p", ctrl: true }, "ctrl+p")).toBe(true);
    expect(keyMatches({ name: "p", ctrl: false }, "ctrl+p")).toBe(false);
    expect(parseKeybind("none")).toEqual([]);
    expect(parseKeybind("ctrl+x q")).toEqual([]);
    expect(keyMatches({ name: "c", meta: true }, "cmd+c")).toBe(true);
    expect(keyMatches({ name: "c", super: true }, "cmd+c")).toBe(true);
    expect(keyMatches({ name: "c", ctrl: true }, "cmd+c")).toBe(false);
  });

  test("copy defaults to the platform clipboard shortcut", () => {
    expect(defaultCopyKeybind()).toBe(process.platform === "darwin" ? "cmd+c" : "ctrl+shift+c");
    expect(defaultTuiConfig().keybinds.copy).toBe(defaultCopyKeybind());
  });

  test("missing DEVCTL_TUI_CONFIG path falls through to the user file", () => {
    const prevHome = process.env.DEVCTL_HOME;
    const prevOverride = process.env.DEVCTL_TUI_CONFIG;
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-tui-missing-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    process.env.DEVCTL_HOME = dir;
    writeFileSync(join(dir, "tui.json"), `{ "theme": "gruvbox" }`);
    process.env.DEVCTL_TUI_CONFIG = join(dir, "does-not-exist.json");
    try {
      expect(resolveTuiOverridePath(dir)).toBeUndefined();
      const cfg = loadTuiConfig(dir);
      expect(cfg.theme).toBe("gruvbox");
    } finally {
      if (prevHome === undefined) {
        delete process.env.DEVCTL_HOME;
      } else {
        process.env.DEVCTL_HOME = prevHome;
      }
      if (prevOverride === undefined) {
        delete process.env.DEVCTL_TUI_CONFIG;
      } else {
        process.env.DEVCTL_TUI_CONFIG = prevOverride;
      }
    }
  });

  test("a YAML ui.keymap applies on top of the hardcoded defaults", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-tui-yaml-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    const cfg = loadTuiConfig(dir, { leader: "ctrl+z", quit: "x" });
    expect(cfg.keybinds.leader).toBe("ctrl+z");
    expect(cfg.keybinds.quit).toBe("x");
    // Untouched bindings still come from the hardcoded defaults.
    expect(cfg.keybinds.command_list).toBe("ctrl+p");
  });

  test("tui.json still wins over a YAML ui.keymap for the same binding", () => {
    const prevHome = process.env.DEVCTL_HOME;
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-tui-yaml-precedence-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    process.env.DEVCTL_HOME = dir;
    try {
      writeFileSync(userTuiConfigPath(), JSON.stringify({ keybinds: { leader: "ctrl+y" } }));
      // The YAML keymap sets both leader and quit; tui.json only overrides
      // leader, so quit must still come from the YAML layer underneath it —
      // this is a per-key merge, not tui.json wholesale replacing it.
      const cfg = loadTuiConfig(dir, { leader: "ctrl+z", quit: "x" });
      expect(cfg.keybinds.leader).toBe("ctrl+y");
      expect(cfg.keybinds.quit).toBe("x");
    } finally {
      if (prevHome === undefined) {
        delete process.env.DEVCTL_HOME;
      } else {
        process.env.DEVCTL_HOME = prevHome;
      }
    }
  });
});
