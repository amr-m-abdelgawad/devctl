import { describe, expect, test } from "bun:test";
import { commandArgs, commandSearchToken, filterCommands, leaderAction, lookupCommand, parseExecArgs, parseRestartArgs } from "./commands.ts";

describe("slash commands", () => {
  test("resolves aliases like /q /quit /exit", () => {
    expect(lookupCommand("/q")?.name).toBe("exit");
    expect(lookupCommand("quit")?.name).toBe("exit");
    expect(lookupCommand("/themes")?.name).toBe("themes");
    expect(lookupCommand("/init")?.name).toBe("setup");
  });

  test("filters palette query", () => {
    const hits = filterCommands("the");
    expect(hits.map((c) => c.name)).toEqual(["themes"]);
  });

  test("ranks name and alias matches ahead of descriptions", () => {
    expect(filterCommands("set")[0]?.name).toBe("settings");
    expect(filterCommands("q")[0]?.name).toBe("exit");
    expect(filterCommands("ident")[0]?.name).toBe("auth");
    expect(filterCommands("cfg")[0]?.name).toBe("config");
    expect(filterCommands("error").some((c) => c.name === "filter")).toBe(true);
    expect(filterCommands("login")[0]?.name).toBe("auth");
    expect(filterCommands("cascade")[0]?.name).toBe("restart");
  });

  test("keeps the command token when arguments are typed", () => {
    expect(commandSearchToken("/start api")).toBe("start");
    expect(filterCommands("start api")[0]?.name).toBe("start");
    expect(filterCommands("/logs --level error")[0]?.name).toBe("logs");
  });

  test("single-letter queries only prefix names or aliases", () => {
    const hits = filterCommands("s");
    expect(hits[0]?.name).toBe("services");
    expect(
      hits.every((c) => c.name.startsWith("s") || c.aliases.some((alias) => alias === "s" || alias.startsWith("s"))),
    ).toBe(true);
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

  test("update and daemon and provenance are first-class commands", () => {
    expect(lookupCommand("/update")?.name).toBe("update");
    expect(lookupCommand("/daemon")?.name).toBe("daemon");
    expect(lookupCommand("/bootstrap")?.name).toBe("daemon");
    expect(lookupCommand("/diff")?.name).toBe("diff");
    expect(lookupCommand("/provenance")?.name).toBe("diff");
    expect(lookupCommand("/split")?.name).toBe("split");
    expect(lookupCommand("/trace")?.name).toBe("trace");
  });
});

describe("parseRestartArgs", () => {
  test("strips cascade flags from service names", () => {
    expect(parseRestartArgs(["api", "--cascade"])).toEqual({ services: ["api"], cascade: true });
    expect(parseRestartArgs(["-c", "api", "worker"])).toEqual({ services: ["api", "worker"], cascade: true });
    expect(parseRestartArgs(["api"])).toEqual({ services: ["api"], cascade: false });
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
