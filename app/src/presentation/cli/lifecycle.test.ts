import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import type { PersistedState } from "../../domain/session/session.ts";
import { addStatus } from "./lifecycle.ts";

const NOT_ANSWERING = "devctl is running but not answering. Wait for it to catch up.";
const PERSISTED = { session_id: "s1", repo_root: "/repo", profile: "", processes: [{ name: "api", pid: 41 }] } as unknown as PersistedState;

// `devctl status` against a lookup that found no daemon to talk to.
async function status(found: { notice?: string }, args: string[] = []): Promise<string> {
  const runtime = {
    findDaemon: async () => ({ repoRoot: "/repo", client: undefined, notice: found.notice }),
    readPersistedState: () => PERSISTED,
  } as unknown as ClientRuntime;
  const root = new Command().option("--config <path>").exitOverride();
  addStatus(root, runtime);
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await root.parseAsync(["node", "devctl", "status", ...args], { from: "node" });
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

describe("devctl status without a daemon to talk to", () => {
  test("with no daemon it says so and lists what the last session left", async () => {
    const out = await status({});
    expect(out).toContain("supervisor is not running\n");
    expect(out).toContain("last session s1");
    expect(out).toContain("api\tstopped\tUNKNOWN\t41\n");
  });

  test("with a daemon that did not answer it says only that, and shows nothing as stopped", async () => {
    expect(await status({ notice: NOT_ANSWERING })).toBe(`${NOT_ANSWERING}\n`);
  });

  test("--json stays one JSON document and carries the notice", async () => {
    expect(JSON.parse(await status({ notice: NOT_ANSWERING }, ["--json"]))).toEqual({ running: false, notice: NOT_ANSWERING, persisted: PERSISTED });
    expect(JSON.parse(await status({}, ["--json"]))).toEqual({ running: false, persisted: PERSISTED });
  });
});
