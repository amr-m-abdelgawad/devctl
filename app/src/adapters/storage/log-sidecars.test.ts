import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { SessionLogWriter } from "./log-persist.ts";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "devctl-sidecar-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PAD = "p".repeat(1_000);

function line(seq: number, extra = ""): string {
  return `${JSON.stringify({ seq, service: "api", body: `line ${seq} ${PAD}${extra}` })}\n`;
}

function checkpoints(path: string): Array<[number, number]> {
  return readFileSync(path, "utf8").trimEnd().split("\n").map((row) => row.split(" ").map(Number) as [number, number]);
}

function diskBytes(dir: string): number {
  return readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
}

describe("part index", () => {
  test("holds the part's first seq, a checkpoint each 64 KiB, and its end", async () => {
    const dir = tmp();
    const writer = new SessionLogWriter(dir, 64 * 1024 * 1024, { maxSessionBytes: 1024 * 1024 * 1024 });
    // Seqs 10, 13, 16, ... as one service of several would see them.
    for (let n = 0; n < 400; n += 1) {
      writer.write("api", line(10 + 3 * n), 10 + 3 * n);
      if (n % 37 === 0) {
        await writer.flush();
      }
    }
    await writer.close();
    const part = readFileSync(join(dir, "api.jsonl"));
    const rows = checkpoints(join(dir, "api.idx"));
    expect(rows[0]).toEqual([0, 9]);
    expect(rows.at(-1)).toEqual([part.length, 10 + 3 * 399]);
    expect(rows.length).toBeGreaterThan(5);
    for (const [index, [offset, bound]] of rows.entries()) {
      if (index > 0 && index < rows.length - 1) {
        // A line starts there, and it is the first seq above the bound.
        expect(offset - rows[index - 1]![0]).toBeGreaterThanOrEqual(64 * 1024);
        expect(part[offset - 1]).toBe(0x0a);
        expect(JSON.parse(part.subarray(offset, part.indexOf(0x0a, offset)).toString("utf8")).seq).toBe(bound + 3);
      }
    }
  });

  test("its bytes count toward the session and it goes with its part", async () => {
    const dir = tmp();
    // Parts of 16 KiB under a 128 KiB session: the oldest are evicted as it fills.
    const writer = new SessionLogWriter(dir, 64 * 1024 * 1024, { maxSessionBytes: 128 * 1024 });
    for (let seq = 1; seq <= 300; seq += 1) {
      writer.write("api", line(seq), seq);
      if (seq % 10 === 0) {
        await writer.flush();
      }
    }
    await writer.close();
    const names = readdirSync(dir);
    const parts = names.filter((name) => name.endsWith(".jsonl"));
    expect(parts.length).toBeGreaterThan(2);
    expect(parts).not.toContain("api.jsonl");
    expect(names.filter((name) => name.endsWith(".idx")).sort()).toEqual(parts.map((name) => name.replace(/\.jsonl$/, ".idx")).sort());
    expect(writer.sessionByteCount()).toBe(diskBytes(dir));
    expect(writer.sessionByteCount()).toBeLessThanOrEqual(128 * 1024);
  });

  test("lines without a seq get no index, and a sidecar whose part is gone is removed at start", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "gone~3.idx"), "0 41\n");
    writeFileSync(join(dir, "gone~3.patch"), line(42));
    writeFileSync(join(dir, "kept.jsonl"), line(1));
    writeFileSync(join(dir, "kept.idx"), "0 0\n");
    const writer = new SessionLogWriter(dir, 64 * 1024 * 1024, { maxSessionBytes: 1024 * 1024 });
    expect(existsSync(join(dir, "gone~3.idx"))).toBe(false);
    expect(existsSync(join(dir, "gone~3.patch"))).toBe(false);
    expect(existsSync(join(dir, "kept.idx"))).toBe(true);
    expect(writer.sessionByteCount()).toBe(diskBytes(dir));
    writer.write("raw", "not a record\n");
    await writer.close();
    expect(existsSync(join(dir, "raw.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "raw.idx"))).toBe(false);
  });
});
