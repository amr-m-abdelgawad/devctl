import { Command } from "commander";
import { describe, expect, test } from "bun:test";
import type { ClientRuntime, Controller } from "../../application/client-runtime.ts";
import { addWeb } from "./web.ts";

function captureStdout(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    output: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

function stubRuntime(): ClientRuntime {
  return {
    openController: async () =>
      ({
        client: undefined,
        close: async () => {},
      }) as unknown as Controller,
  } as unknown as ClientRuntime;
}

async function parseWeb(args: string[]): Promise<string> {
  const root = new Command();
  root.option("-c, --config <path>");
  addWeb(root, stubRuntime());
  const cap = captureStdout();
  try {
    await root.parseAsync(["node", "devctl", ...args], { from: "node" });
  } finally {
    cap.restore();
  }
  return cap.output();
}

describe("devctl web", () => {
  test("status --json emits running:false when the supervisor is stopped", async () => {
    const json = await parseWeb(["web", "status", "--json"]);
    expect(JSON.parse(json)).toEqual({ running: false });
  });

  test("status without --json prints WEB STOPPED", async () => {
    const text = await parseWeb(["web", "status"]);
    expect(text).toBe("WEB  STOPPED\n");
  });

  test("start prints the control URL with the session token", async () => {
    const runtime = {
      openController: async () =>
        ({
          client: {},
          webStart: async () => ({ url: "http://127.0.0.1:18900/?token=abc" }),
          close: async () => {},
        }) as unknown as Controller,
    } as unknown as ClientRuntime;
    const root = new Command();
    root.option("-c, --config <path>");
    addWeb(root, runtime);
    const cap = captureStdout();
    try {
      await root.parseAsync(["node", "devctl", "web", "start"], { from: "node" });
    } finally {
      cap.restore();
    }
    expect(cap.output()).toBe("http://127.0.0.1:18900/?token=abc\n");
  });
});
