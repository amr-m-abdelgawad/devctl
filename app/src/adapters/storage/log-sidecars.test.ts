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

  test("a replaced record is swapped while it waits in its batch, and patched once written", async () => {
    const dir = tmp();
    const writer = new SessionLogWriter(dir, 64 * 1024 * 1024, { maxSessionBytes: 1024 * 1024 * 1024 });
    writer.write("api", line(1), 1);
    writer.write("api", line(2), 2);
    writer.replace("api", line(1, " tagged"), 1);
    await writer.flush();
    expect(existsSync(join(dir, "api.patch"))).toBe(false);
    writer.replace("api", line(2, " tagged"), 2);
    writer.write("api", line(3), 3);
    await writer.close();
    // Each seq is in the part once, in order; only the late copy is a patch.
    const written = readFileSync(join(dir, "api.jsonl"), "utf8").trimEnd().split("\n").map((row) => JSON.parse(row) as { seq: number; body: string });
    expect(written.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(written.map((row) => row.body.endsWith(" tagged"))).toEqual([true, false, false]);
    expect(readFileSync(join(dir, "api.patch"), "utf8")).toBe(line(2, " tagged"));
    expect(writer.sessionByteCount()).toBe(diskBytes(dir));
    expect(writer.loss).toBe(0);
  });

  test("a patch sits beside the part that holds the original and goes with it", async () => {
    const dir = tmp();
    const writer = new SessionLogWriter(dir, 64 * 1024 * 1024, { maxSessionBytes: 128 * 1024 });
    for (let seq = 1; seq <= 40; seq += 1) {
      writer.write("api", line(seq), seq);
      await writer.flush();
    }
    // Parts of 16 KiB hold about 15 lines: seq 5 is in part 0, seq 20 in part 1.
    writer.replace("api", line(5, " tagged"), 5);
    writer.replace("api", line(20, " tagged"), 20);
    await writer.flush();
    expect(readFileSync(join(dir, "api.patch"), "utf8")).toBe(line(5, " tagged"));
    expect(readFileSync(join(dir, "api~1.patch"), "utf8")).toBe(line(20, " tagged"));
    expect(writer.sessionByteCount()).toBe(diskBytes(dir));
    for (let seq = 41; seq <= 300; seq += 1) {
      writer.write("api", line(seq), seq);
      if (seq % 10 === 0) {
        await writer.flush();
      }
    }
    // The first parts are evicted by now, and a copy of a record in them has nowhere to go.
    writer.replace("api", line(6, " tagged"), 6);
    await writer.close();
    const names = readdirSync(dir);
    expect(names).not.toContain("api.jsonl");
    expect(names.filter((name) => name.endsWith(".patch"))).toEqual([]);
    expect(writer.sessionByteCount()).toBe(diskBytes(dir));
    expect(writer.loss).toBe(0);
  });

  test("a patch the disk refuses is a loss, and a part's patches cannot outgrow a part", async () => {
    const dir = tmp();
    let reserve = true;
    let now = 0;
    const writer = new SessionLogWriter(dir, 64 * 1024 * 1024, { maxSessionBytes: 128 * 1024, hasDiskReserve: () => reserve, now: () => now });
    writer.write("api", line(1), 1);
    await writer.flush();
    reserve = false;
    now += 10_000;
    writer.replace("api", line(1, " tagged"), 1);
    expect(writer.loss).toBe(1);
    reserve = true;
    now += 10_000;
    // 16 KiB of patches fit beside a 16 KiB part; the copy past that is refused.
    const wide = "w".repeat(6_000);
    writer.replace("api", line(1, wide), 1);
    writer.replace("api", line(1, wide), 1);
    writer.replace("api", line(1, wide), 1);
    await writer.close();
    expect(writer.loss).toBe(2);
    expect(statSync(join(dir, "api.patch")).size).toBeLessThanOrEqual(16 * 1024);
  });

  test("a copy standing in for a dropped line is written in seq order", async () => {
    const dir = tmp();
    let reserve = false;
    let now = 0;
    const writer = new SessionLogWriter(dir, 64 * 1024 * 1024, { maxSessionBytes: 1024 * 1024, hasDiskReserve: () => reserve, now: () => now });
    // Seq 1 is refused by a low disk; 2 and 3 wait in the batch when its re-tagged copy arrives.
    writer.write("api", line(1), 1);
    expect(writer.loss).toBe(1);
    reserve = true;
    now += 10_000;
    writer.write("api", line(2), 2);
    writer.write("api", line(3), 3);
    writer.replace("api", line(1, " tagged"), 1);
    await writer.close();
    const seqs = readFileSync(join(dir, "api.jsonl"), "utf8").trimEnd().split("\n").map((row) => (JSON.parse(row) as { seq: number }).seq);
    expect(seqs).toEqual([1, 2, 3]);
    expect(checkpoints(join(dir, "api.idx"))[0]).toEqual([0, 0]);
    expect(existsSync(join(dir, "api.patch"))).toBe(false);
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
