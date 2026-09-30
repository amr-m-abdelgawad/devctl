import { constants, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ProcessChunkHandler } from "../../ports/process-runtime.ts";
import { writeFileSecure } from "../storage/storage.ts";
import { replayDrained } from "./fifo-drain.ts";
import { closeQuiet, fifoChunks, sleepMs } from "./fifo-reader.ts";
import { drainSpoolDir, drainStoppedPath, StdioSentinel, stopPreviousDrainer } from "./fifo-sentinel.ts";
import { pumpChunks, type StreamName } from "./output-pump.ts";

const HANDOFF_WAIT_MS = 1_000;
const HANDOFF_POLL_MS = 5;
const STREAMS: readonly StreamName[] = ["stdout", "stderr"];

type StreamRecord = { service: string; stream: StreamName; pid: number; fifo: string };

type LiveStream = StreamRecord & {
  /** The daemon's non-blocking read end. The sentinel holds a copy of it. */
  fd: number;
  /** Bytes read from the FIFO that the handler has not accepted yet. */
  unaccepted: number;
};

export type ServiceFifos = {
  /** The service's O_RDWR ends, for its stdout and stderr. Only captured streams have one. */
  stdoutFd?: number;
  stderrFd?: number;
  /** After the spawn: drops the service ends here and starts reading output as `pid`. */
  attach(pid: number, onChunk: ProcessChunkHandler, paused?: () => boolean): void;
  /** The spawn failed, so nothing will write to these FIFOs. */
  abandon(): void;
};

export type StdioHandlerFor = (service: string, pid: number) => ProcessChunkHandler;

/**
 * Service stdout and stderr through FIFOs on Linux and macOS. The service
 * holds its FIFO O_RDWR, so a write never gets EPIPE or SIGPIPE and blocks
 * while nobody reads. The daemon reads the FIFOs itself. Its sentinel holds
 * them for one drainer in case the daemon dies, and the next daemon stops
 * that drainer, replays its spool, and reads the FIFOs again.
 */
export class FifoStdio {
  private readonly live = new Map<string, LiveStream>();
  private readonly opening = new Map<string, StreamRecord>();
  private readonly sentinel: StdioSentinel;
  private stopped = false;
  private refreshQueued = false;
  private seq = 0;

  constructor(
    private readonly root: string,
    spoolMaxBytes: number,
  ) {
    this.sentinel = new StdioSentinel(root, spoolMaxBytes);
  }

  /** FIFOs for the captured streams of a service about to start; undefined when none can be made. */
  async open(service: string, capture: Record<StreamName, boolean>): Promise<ServiceFifos | undefined> {
    const streams = STREAMS.filter((stream) => capture[stream]);
    if (streams.length === 0 || this.stopped) {
      return undefined;
    }
    const base = join(fifoDir(this.root), `${safeName(service)}-${process.pid}-${this.seq++}`);
    const paths = streams.map((stream) => `${base}.${stream}`);
    if (!(await makeFifos(fifoDir(this.root), paths))) {
      return undefined;
    }
    const ends: { stream: StreamName; fifo: string; readFd: number; serviceFd: number }[] = [];
    try {
      streams.forEach((stream, index) => {
        const fifo = paths[index]!;
        // Read end first: the service end is then never the only one open.
        const readFd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
        ends.push({ stream, fifo, readFd, serviceFd: -1 });
        ends[index]!.serviceFd = openSync(fifo, constants.O_RDWR);
      });
    } catch {
      for (const end of ends) {
        closeQuiet(end.readFd);
        closeQuiet(end.serviceFd);
      }
      paths.forEach(unlinkQuiet);
      return undefined;
    }
    // Recorded before the spawn, so a daemon that dies right after it still hands these on.
    for (const end of ends) {
      this.opening.set(end.fifo, { service, stream: end.stream, pid: 0, fifo: end.fifo });
    }
    this.writeManifest();
    const done = (end: (typeof ends)[number]): void => {
      closeQuiet(end.serviceFd);
      this.opening.delete(end.fifo);
    };
    return {
      stdoutFd: ends.find((end) => end.stream === "stdout")?.serviceFd,
      stderrFd: ends.find((end) => end.stream === "stderr")?.serviceFd,
      attach: (pid, onChunk, paused) => {
        for (const end of ends) {
          done(end);
          const stream: LiveStream = { service, stream: end.stream, pid, fifo: end.fifo, fd: end.readFd, unaccepted: 0 };
          this.live.set(end.fifo, stream);
          this.follow(stream, onChunk, paused);
        }
        this.changed();
      },
      abandon: () => {
        for (const end of ends) {
          done(end);
          closeQuiet(end.readFd);
          unlinkQuiet(end.fifo);
        }
        this.writeManifest();
      },
    };
  }

  /** True when this daemon reads `pid`'s output from a FIFO. */
  follows(pid: number): boolean {
    return [...this.live.values()].some((stream) => stream.pid === pid);
  }

  /**
   * For a shutdown that leaves services running: stop reading, then wait
   * until what was already read is accepted. The rest stays in the FIFOs for
   * the drainer the sentinel starts once this daemon exits, and no stream is
   * reported as ended.
   */
  async handoff(): Promise<void> {
    if (this.refreshQueued) {
      this.refresh();
    }
    this.stopped = true;
    const deadline = Date.now() + HANDOFF_WAIT_MS;
    while ([...this.live.values()].some((stream) => stream.unaccepted > 0) && Date.now() < deadline) {
      await sleepMs(HANDOFF_POLL_MS);
    }
  }

  /**
   * Picks up the FIFOs a previous daemon left. It opens them first, since a
   * FIFO keeps its bytes only while someone holds it. Then it stops the
   * drainer and holds the FIFOs in this daemon's sentinel. `replayed`
   * settles once the drain spool has been handed over in order. Only after
   * that are the FIFOs read, so every stream stays in the order it was
   * written.
   */
  async takeOver(handlerFor: StdioHandlerFor, paused?: () => boolean): Promise<{ replayed: Promise<void> }> {
    const taken: LiveStream[] = [];
    for (const record of readManifest(this.root)) {
      if (this.live.has(record.fifo)) {
        continue;
      }
      try {
        taken.push({ ...record, fd: openSync(record.fifo, constants.O_RDONLY | constants.O_NONBLOCK), unaccepted: 0 });
      } catch {
        // removed, or not a FIFO any more
      }
    }
    await stopPreviousDrainer(this.root);
    unlinkQuiet(drainStoppedPath(this.root));
    for (const stream of taken) {
      this.live.set(stream.fifo, stream);
    }
    this.removeStrayFifos();
    this.writeManifest();
    this.refresh();
    const replayed = replayDrained(drainSpoolDir(this.root), handlerFor).then(() => {
      for (const stream of taken) {
        this.follow(stream, handlerFor(stream.service, stream.pid), paused);
      }
    });
    return { replayed };
  }

  private follow(stream: LiveStream, onChunk: ProcessChunkHandler, paused?: () => boolean): void {
    const accept: ProcessChunkHandler = (name, bytes, meta) => {
      const accepted = onChunk(name, bytes, meta);
      if (accepted !== false) {
        stream.unaccepted -= bytes.byteLength;
      }
      return accepted;
    };
    void pumpChunks(this.counted(stream), stream.stream, accept, { paused }).then(() => this.ended(stream));
  }

  private async *counted(stream: LiveStream): AsyncGenerator<Uint8Array> {
    for await (const chunk of fifoChunks(stream.fd, () => this.stopped)) {
      stream.unaccepted += chunk.byteLength;
      yield chunk;
    }
  }

  // Every writer closed the FIFO: the service and anything that inherited its stdio exited.
  private ended(stream: LiveStream): void {
    this.live.delete(stream.fifo);
    closeQuiet(stream.fd);
    unlinkQuiet(stream.fifo);
    this.changed();
  }

  private changed(): void {
    this.writeManifest();
    if (this.refreshQueued || this.stopped) {
      return;
    }
    this.refreshQueued = true;
    // One sentinel respawn for a burst of starts and exits.
    setImmediate(() => this.refresh());
  }

  private refresh(): void {
    this.refreshQueued = false;
    if (this.stopped) {
      return;
    }
    try {
      this.sentinel.hold([...this.live.values()].map(({ fd, service, stream, pid }) => ({ fd, service, stream, pid })));
    } catch {
      // No sentinel: the FIFOs still hold what services write until the next daemon reads them.
    }
  }

  private writeManifest(): void {
    const records: StreamRecord[] = [...this.opening.values(), ...[...this.live.values()].map(({ service, stream, pid, fifo }) => ({ service, stream, pid, fifo }))];
    try {
      writeFileSecure(manifestPath(this.root), `${JSON.stringify(records)}\n`);
    } catch {
      // only the next daemon's takeover depends on it
    }
  }

  private removeStrayFifos(): void {
    let names: string[] = [];
    try {
      names = readdirSync(fifoDir(this.root));
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(fifoDir(this.root), name);
      if (!this.live.has(path) && !this.opening.has(path)) {
        unlinkQuiet(path);
      }
    }
  }
}

function fifoDir(root: string): string {
  return join(root, "fifo");
}

function manifestPath(root: string): string {
  return join(root, "streams.json");
}

function readManifest(root: string): StreamRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath(root), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is StreamRecord =>
    typeof item === "object" && item !== null && typeof item.service === "string" && (item.stream === "stdout" || item.stream === "stderr")
    && Number.isInteger(item.pid) && typeof item.fifo === "string" && item.fifo.startsWith(fifoDir(root)));
}

async function makeFifos(dir: string, paths: string[]): Promise<boolean> {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const made = Bun.spawn({ cmd: ["mkfifo", "-m", "600", ...paths], stdout: "ignore", stderr: "ignore" });
    return (await made.exited) === 0;
  } catch {
    return false;
  }
}

function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_");
  return cleaned === "" ? "service" : cleaned;
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}
