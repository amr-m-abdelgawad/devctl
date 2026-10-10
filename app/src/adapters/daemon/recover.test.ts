import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ProcessChunkHandler } from "../../ports/process-runtime.ts";
import { recoverSession, type RecoverHost } from "./recover.ts";

type Ingested = { service: string; stream: string; pid: number; readAtMs: number; text: string; end?: boolean };

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Only what recoverSession touches before it finds no persisted state.
function hostWith(takeOver: (handlerFor: (service: string, pid: number) => ProcessChunkHandler) => void, ingest = true): { host: RecoverHost; ingested: Ingested[]; tookOver: () => boolean } {
  const repoRoot = mkdtempSync(join(tmpdir(), "devctl-recover-"));
  dirs.push(repoRoot);
  const ingested: Ingested[] = [];
  let called = false;
  const host = {
    cfg: { repoRoot },
    clock: { unixMs: () => 9_999 },
    logs: {
      append: () => undefined,
      ingestPaused: () => false,
      ingestChunk: ingest
        ? (chunk: { service: string; stream: string; pid: number; readAtMs: number; bytes: Uint8Array; end?: boolean }) => {
          ingested.push({ service: chunk.service, stream: chunk.stream, pid: chunk.pid, readAtMs: chunk.readAtMs, text: Buffer.from(chunk.bytes).toString("utf8"), end: chunk.end });
          return true;
        }
        : undefined,
    },
    procs: {
      takeOverStdio: async (handlerFor: (service: string, pid: number) => ProcessChunkHandler) => {
        called = true;
        takeOver(handlerFor);
        return { replayed: Promise.resolve() };
      },
    },
  } as unknown as RecoverHost;
  return { host, ingested, tookOver: () => called };
}

describe("session recovery of service output", () => {
  test("replayed output keeps the time it was read, and live output is stamped when it arrives", async () => {
    const { host, ingested } = hostWith((handlerFor) => {
      const handler = handlerFor("api", 42);
      handler("stdout", Buffer.from("spooled\n"), { pid: 42, readAtMs: 1_234 });
      handler("stdout", Buffer.from("live\n"));
      handler("stderr", new Uint8Array(0), { end: true });
    });
    await recoverSession(host);
    expect(ingested).toEqual([
      { service: "api", stream: "stdout", pid: 42, readAtMs: 1_234, text: "spooled\n", end: undefined },
      { service: "api", stream: "stdout", pid: 42, readAtMs: 9_999, text: "live\n", end: undefined },
      { service: "api", stream: "stderr", pid: 42, readAtMs: 9_999, text: "", end: true },
    ]);
  });

  test("without chunk ingest the drainer is left holding the FIFOs", async () => {
    const { host, tookOver } = hostWith(() => undefined, false);
    await recoverSession(host);
    expect(tookOver()).toBe(false);
  });
});
