import { describe, expect, test } from "bun:test";
import { commandArgs, filterCommands, leaderAction, lookupCommand, parseExecArgs } from "./commands.ts";

describe("slash commands", () => {
  test("resolves aliases like /q /quit /exit", () => {
    expect(lookupCommand("/q")?.name).toBe("exit");
    expect(lookupCommand("quit")?.name).toBe("exit");
    expect(lookupCommand("/themes")?.name).toBe("themes");
    expect(lookupCommand("/init")?.name).toBe("setup");
  });

  test("filters palette query", () => {
    const hits = filterCommands("the");
    expect(hits.some((c) => c.name === "themes")).toBe(true);
  });

  test("leader keys match documented shortcuts", () => {
    expect(leaderAction("t")).toBe("themes");
    expect(leaderAction("q")).toBe("exit");
    expect(leaderAction("n")).toBe("start");
  });

  test("parses command args", () => {
    expect(commandArgs("/start auth api")).toEqual(["auth", "api"]);
  });

  test("reveal is a first-class command", () => {
    expect(lookupCommand("/reveal")?.name).toBe("reveal");
  });

  test("buffer is a first-class command", () => {
    expect(lookupCommand("/buffer")?.name).toBe("buffer");
  });

  test("settings is a first-class command", () => {
    expect(lookupCommand("/settings")?.name).toBe("settings");
    expect(lookupCommand("/prefs")?.name).toBe("settings");
  });

  test("copy is a first-class command", () => {
    expect(lookupCommand("/copy")?.name).toBe("copy");
  });

  test("wrap is a first-class command", () => {
    expect(lookupCommand("/wrap")?.name).toBe("wrap");
  });

  test("version is a first-class command", () => {
    expect(lookupCommand("/version")?.name).toBe("version");
    expect(lookupCommand("/v")?.name).toBe("version");
  });

  test("export and exports are first-class commands", () => {
    expect(lookupCommand("/export")?.name).toBe("export");
    expect(lookupCommand("/exports")?.name).toBe("exports");
    expect(lookupCommand("/open-exports")?.name).toBe("exports");
  });

  test("mcp is a first-class command", () => {
    expect(lookupCommand("/mcp")?.name).toBe("mcp");
    expect(lookupCommand("/agent")?.name).toBe("mcp");
  });

  test("run and exec are first-class commands", () => {
    expect(lookupCommand("/run")?.name).toBe("run");
    expect(lookupCommand("/task")?.name).toBe("run");
    expect(lookupCommand("/exec")?.name).toBe("exec");
  });
});

describe("parseExecArgs", () => {
  test("splits service, flags, and command", () => {
    expect(parseExecArgs(["api", "--", "python3", "check.py"])).toEqual({
      service: "api",
      printEnv: false,
      reveal: false,
      command: ["python3", "check.py"],
    });
    expect(parseExecArgs(["--print-env", "--reveal", "api"])).toEqual({
      service: "api",
      printEnv: true,
      reveal: true,
      command: [],
    });
  });
});
