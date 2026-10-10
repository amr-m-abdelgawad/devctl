import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import { addLlm } from "./llm.ts";
import { addTraffic } from "./traffic.ts";

type Seen = { summary?: boolean };

function runtimeCapturing(seen: Seen): ClientRuntime {
  return {
    openController: async () => ({
      llmCallsPage: async (req: { summary?: boolean }) => {
        seen.summary = req.summary;
        return { calls: [], errors: [], nextCursor: "", hasNext: false };
      },
      trafficCallsPage: async (req: { summary?: boolean }) => {
        seen.summary = req.summary;
        return { calls: [], nextCursor: "", hasNext: false };
      },
      close: async () => undefined,
    }),
  } as unknown as ClientRuntime;
}

async function summaryRequested(command: "llm" | "traffic", args: string[]): Promise<boolean | undefined> {
  const seen: Seen = {};
  const root = new Command();
  root.enablePositionalOptions();
  (command === "llm" ? addLlm : addTraffic)(root, runtimeCapturing(seen));
  await root.parseAsync(["node", "devctl", command, ...args], { from: "node" });
  return seen.summary;
}

describe("devctl llm and traffic list pages", () => {
  test("text output asks for rows without bodies", async () => {
    expect(await summaryRequested("llm", [])).toBe(true);
    expect(await summaryRequested("traffic", [])).toBe(true);
  });

  test("--json still asks for whole calls", async () => {
    expect(await summaryRequested("llm", ["--json"])).toBe(false);
    expect(await summaryRequested("traffic", ["--json"])).toBe(false);
  });
});
