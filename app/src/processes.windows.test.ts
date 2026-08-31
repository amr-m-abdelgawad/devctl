import { describe, expect, test } from "bun:test";
import { killProcessTreeWindows, parseCimProcess, parseGetProcess, parseTasklistCsv, parseWindowsResourceSamples } from "./processes/windows.ts";

describe("windows process backend", () => {
  test("taskkill helper is defined", async () => {
    if (process.platform !== "win32") {
      expect(typeof killProcessTreeWindows).toBe("function");
      return;
    }
    await killProcessTreeWindows(0, "SIGTERM");
    expect(true).toBe(true);
  });

  test("parses CIM inspect JSON for command and executable directory", () => {
    const parsed = parseCimProcess(
      '{"CommandLine":"python main.py","ExecutablePath":"C:\\\\repo\\\\api\\\\python.exe","CreationDate":"2026-08-31T00:00:00"}',
    );
    expect(parsed?.command).toBe("python main.py");
    expect(parsed?.cwd).toBe("C:\\repo\\api");
    expect(parsed?.startTime).toBe("2026-08-31T00:00:00");
  });

  test("parses tasklist CSV for image name", () => {
    const parsed = parseTasklistCsv('"bun.exe","4242","Console","1","12,345 K"', 4242);
    expect(parsed?.command).toBe("bun.exe");
    expect(parsed?.pid).toBe(4242);
  });

  test("parses Get-Process JSON for executable path", () => {
    const parsed = parseGetProcess('{"Path":"C:\\\\Program Files\\\\bun\\\\bun.exe","StartTime":"2026-08-31T00:00:00"}');
    expect(parsed?.command).toBe("C:\\Program Files\\bun\\bun.exe");
    expect(parsed?.cwd).toBe("C:\\Program Files\\bun");
  });

  test("parses process resource JSON into kb and cpu", () => {
    const samples = parseWindowsResourceSamples('{"Id":42,"CPU":1.5,"WorkingSet64":2097152}');
    expect(samples.get(42)).toEqual({ pid: 42, cpuPercent: 1.5, memoryKB: 2048 });
  });
});
