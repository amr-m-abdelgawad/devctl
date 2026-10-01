// A service for devctl to run: writes `<name> seq=<n> t=<unix ms> xxx…` lines
// with blocking writes, so a full FIFO or pipe slows it down instead of
// losing or buffering output, then `<name> done count=<n> elapsed_ms=<ms>`,
// and stays up so its stream stays open.
//
//   bun flood.ts --rate 15000 --count 300000 [--width 120] [--name flood] [--stderr] [--start-at <unix ms>]
//
// `--rate 0` writes as fast as the reader takes it. `--width` is the whole
// line including its newline.
import { writeSync } from "node:fs";
import { parseArgs } from "./rpc.ts";

const args = parseArgs(process.argv.slice(2));
const rate = Number(args.rate ?? "15000");
const count = Number(args.count ?? "100000");
const width = Number(args.width ?? "120");
const name = args.name ?? "flood";
const fd = args.stderr === "1" ? 2 : 1;
const BATCH_LINES = 512;

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function writeAll(bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") {
        throw err;
      }
      sleepSync(1);
    }
  }
}

function lines(first: number, last: number): Buffer {
  let text = "";
  const now = Date.now();
  for (let n = first; n <= last; n += 1) {
    const head = `${name} seq=${n} t=${now} `;
    text += `${head}${"x".repeat(Math.max(0, width - head.length - 1))}\n`;
  }
  return Buffer.from(text);
}

const startAt = args["start-at"] === undefined ? 0 : Number(args["start-at"]);
if (startAt > Date.now()) {
  sleepSync(startAt - Date.now());
}
const started = Date.now();
let written = 0;
while (written < count) {
  const due = rate <= 0 ? count : Math.min(count, Math.floor(((Date.now() - started) * rate) / 1000));
  if (due <= written) {
    sleepSync(1);
    continue;
  }
  const last = Math.min(due, written + BATCH_LINES);
  writeAll(lines(written + 1, last));
  written = last;
}
const elapsed = Date.now() - started;
writeAll(Buffer.from(`${name} done count=${count} elapsed_ms=${elapsed}\n`));
setInterval(() => undefined, 1 << 30);
