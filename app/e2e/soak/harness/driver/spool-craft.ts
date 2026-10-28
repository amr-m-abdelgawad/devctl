// Leaves what a daemon killed mid-flood leaves behind: its session directory
// with the records it had persisted, and a pipeline spool segment of output
// it had read but not parsed. The segment is written with the image's own
// spool encoder, so the format is exactly what the daemon reads back.
//
//   bun spool-craft.ts --spool-root <state>/log-spool --logs-root <home>/logs
//                      --session <id> --service api --pid 4242 --at <unix ms>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeSegment } from "../../../../src/adapters/storage/ingest/spool.ts";
import { parseArgs } from "./rpc.ts";

const args = parseArgs(process.argv.slice(2));
const session = args.session ?? "2026-09-01T00-00-00Z-dead01";
const service = args.service ?? "api";
const pid = Number(args.pid ?? "4242");
const at = Number(args.at ?? String(Date.now() - 60_000));
const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, "_") || "stream";

// The dead daemon's session: three records it persisted before it died.
const sessionDir = join(args["logs-root"] ?? "/work/home/logs", `session-${session}`);
mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
writeFileSync(join(sessionDir, "FORMAT"), "jsonl\n", { mode: 0o600 });
const persisted = [1, 2, 3].map((seq) => JSON.stringify({
  seq,
  timeUnixNano: (at - 1_000 + seq) * 1_000_000,
  severityNumber: 0,
  severityText: "UNKNOWN",
  body: `before crash ${seq}`,
  attributes: {},
  resource: { "service.name": service, "process.pid": pid },
  service,
  source: "stdout",
  raw: `before crash ${seq}`,
  timestamp: new Date(at - 1_000 + seq).toISOString(),
  stream: "stdout",
}));
writeFileSync(join(sessionDir, `${safe(service)}.jsonl`), `${persisted.join("\n")}\n`, { mode: 0o600 });
// Its owner is gone: a pid no process has.
writeFileSync(join(sessionDir, "manifest.json"), `${JSON.stringify({ repo: "", retentionDays: 0, bytes: 0, owner: { pid: 999_999 } })}\n`, { mode: 0o600 });

// Output it had read and not parsed, in two reads; the second ends mid-line.
const spoolDir = join(args["spool-root"] ?? "", `${safe(session)}_${safe(`${service}\0stdout\0${pid}`)}`);
mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
const segment = encodeSegment({ session, service, stream: "stdout", pid }, [
  { readAtMs: at, bytes: Buffer.from("replayed 1\nreplayed 2\n") },
  { readAtMs: at + 250, bytes: Buffer.from("replayed 3 with no newline") },
]);
writeFileSync(join(spoolDir, "00000000.spool"), segment, { mode: 0o600 });
console.log(JSON.stringify({ sessionDir, spoolDir, at }));
