import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveWorkerUrl } from "./worker-resolver.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "devctl-worker-url-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveWorkerUrl", () => {
  test("runs the TypeScript source when no bundle sits beside it", () => {
    const source = pathToFileURL(join(dir, "log-worker.ts"));
    expect(resolveWorkerUrl("log-worker", source, false).href).toBe(source.href);
  });

  test("prefers the bundled worker beside the npm entrypoint", () => {
    writeFileSync(join(dir, "log-worker.js"), "");
    const source = pathToFileURL(join(dir, "log-worker.ts"));
    expect(resolveWorkerUrl("log-worker", source, false).href).toBe(pathToFileURL(join(dir, "log-worker.js")).href);
  });

  test("a compiled binary loads the worker embedded beside its entrypoint", () => {
    const posix = new URL("./log-worker.ts", "file:///$bunfs/root/devctl-linux-x64");
    expect(resolveWorkerUrl("log-worker", posix, true).href).toBe("file:///$bunfs/root/log-worker.js");
    const windows = new URL("./event-loop-watchdog-worker.ts", "file:///B:/~BUN/root/devctl-windows-x64.exe");
    expect(resolveWorkerUrl("event-loop-watchdog-worker", windows, true).href).toBe("file:///B:/~BUN/root/event-loop-watchdog-worker.js");
  });
});
