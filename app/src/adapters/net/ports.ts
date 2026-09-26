import type { PortHolder } from "../../domain/net/ports.ts";
export type { PortHolder } from "../../domain/net/ports.ts";
import { spawn } from "bun";
import { createServer } from "node:net";
import { type DevctlConfig } from "../config/index.ts";
import { DevctlError, hintError, KindConfiguration, KindProcessStart, wrapError } from "../../shared/errors.ts";

const MAX_PORT = 65535;
const MIN_PORT = 1;
const PORT_LOOKUP_TIMEOUT_MS = 3_000;
const PORT_ALLOCATION_ATTEMPTS = 32;

export async function assignPorts(
  cfg: DevctlConfig,
  selected: string[],
  existing: Record<string, Record<string, number>> = {},
): Promise<Record<string, Record<string, number>>> {
  const used: Record<number, string> = {};
  for (const [name, ports] of Object.entries(existing)) {
    for (const val of Object.values(ports)) {
      used[val] = name;
    }
  }
  const assigned: Record<string, Record<string, number>> = {};
  // The kernel can reissue an ephemeral port as soon as its probe socket closes.
  // Hold every reservation until the whole selection is chosen.
  const release: Array<() => Promise<void>> = [];
  try {
    for (const [name, svc] of Object.entries(cfg.services)) {
      if (selected.length > 0 && !selected.includes(name)) {
        continue;
      }
      const ports: Record<string, number> = {};
      for (const spec of svc.ports) {
        const held = existing[name]?.[spec.name];
        let val = held && held >= MIN_PORT ? held : spec.value;
        if (held === undefined && spec.auto) {
          val = await allocatePort(used, release, name);
        }
        if (val < MIN_PORT || val > MAX_PORT) {
          throw new DevctlError(KindConfiguration, `invalid port ${val} on service ${name}`, { service: name });
        }
        if (used[val] && used[val] !== name) {
          throw new DevctlError(KindConfiguration, `duplicate port ${val} used by ${used[val]} and ${name}`, { service: name });
        }
        const reused = held === val;
        if (!reused && !spec.auto && !(await available(val))) {
          throw await portBusyError(name, spec.name, val);
        }
        used[val] = name;
        ports[spec.name] = val;
      }
      assigned[name] = ports;
    }
    return assigned;
  } finally {
    await Promise.all(release.map((close) => close()));
  }
}

type PortReservation = {
  readonly port: number;
  readonly close: () => Promise<void>;
};

function reservePort(): Promise<PortReservation> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        server.close();
        reject(wrapError(KindConfiguration, "unable to allocate dynamic port", new Error("no address")));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
    server.on("error", (err) => reject(wrapError(KindConfiguration, "unable to allocate dynamic port", err)));
  });
}

async function allocatePort(
  used: Record<number, string>,
  release: Array<() => Promise<void>>,
  service: string,
): Promise<number> {
  for (let attempt = 0; attempt < PORT_ALLOCATION_ATTEMPTS; attempt++) {
    const reservation = await reservePort();
    release.push(reservation.close);
    if (used[reservation.port] === undefined) {
      return reservation.port;
    }
  }
  throw new DevctlError(KindConfiguration, "unable to allocate dynamic port", { service });
}

export async function occupiedFixedPorts(svc: { ports: Array<{ name: string; value: number; auto: boolean }> }): Promise<Record<string, number> | undefined> {
  const fixed = svc.ports.filter((spec) => !spec.auto && spec.value >= MIN_PORT);
  if (fixed.length === 0) {
    return undefined;
  }
  const ports: Record<string, number> = {};
  for (const spec of fixed) {
    if (await available(spec.value)) {
      return undefined;
    }
    ports[spec.name] = spec.value;
  }
  return ports;
}

export function available(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

export async function portBusyError(service: string, portName: string, port: number): Promise<DevctlError> {
  const holder = await findPortHolder(port);
  return portBusyErrorFromHolder(service, portName, port, holder);
}

export function portBusyErrorFromHolder(
  service: string,
  portName: string,
  port: number,
  holder?: PortHolder,
): DevctlError {
  const field = portName === "" ? `${service} port` : `${service} ports.${portName}`;
  if (holder && holder.pid === process.pid) {
    return hintError(
      KindProcessStart,
      `${service} blocked: this TUI already holds port ${port}`,
      `Stop the proxy from the Proxy screen, or change ${field} in .devctl.`,
      service,
    );
  }
  if (holder) {
    return hintError(
      KindProcessStart,
      `${service} blocked: ${holder.command} (pid ${holder.pid}) is using port ${port}`,
      `Open Doctor and press enter to free port ${port}, or change ${field} in .devctl.`,
      service,
    );
  }
  return hintError(
    KindProcessStart,
    `${service} blocked: port ${port} is already in use`,
    `Something is listening on ${port}. Open Doctor to free it, or change ${field} in .devctl.`,
    service,
  );
}

export function parseLsof(text: string, port: number): PortHolder | undefined {
  const lines = text.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("COMMAND"));
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const command = parts[0] ?? "";
    const pid = Number(parts[1]);
    if (command !== "" && Number.isInteger(pid) && pid > 0) {
      return { port, pid, command };
    }
  }
  return undefined;
}

export async function findPortHolder(port: number): Promise<PortHolder | undefined> {
  if (process.platform === "win32") {
    return findPortHolderWindows(port);
  }
  const lsofHolder = await lsofPortHolder(port);
  if (lsofHolder) {
    return lsofHolder;
  }
  return fuserPortHolder(port);
}

// A missing lsof/fuser binary (minimal container, WSL) degrades to "holder unknown" rather than crashing.
// Both commands can also hang after a WSL or dev-container resume; the timeout keeps port checks from stalling restart.
async function commandOutput(cmd: string[], includeStderr: boolean): Promise<string> {
  try {
    const proc = spawn({ cmd, stdout: "pipe", stderr: includeStderr ? "pipe" : "ignore" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<string>((resolve) => {
      timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // already exited
        }
        resolve("");
      }, PORT_LOOKUP_TIMEOUT_MS);
    });
    const finished = (async (): Promise<string> => {
      const out = await readSpawnPipe(proc.stdout);
      const err = includeStderr ? await readSpawnPipe(proc.stderr) : "";
      await proc.exited;
      return includeStderr ? `${out} ${err}` : out;
    })().catch(() => "");
    try {
      return await Promise.race([finished, timedOut]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  } catch {
    // Missing lsof/fuser, or the process could not be spawned.
    return "";
  }
}

async function readSpawnPipe(stream: ReadableStream<Uint8Array> | number | null | undefined): Promise<string> {
  if (stream == null || typeof stream === "number") {
    return "";
  }
  return new Response(stream).text();
}

async function lsofPortHolder(port: number): Promise<PortHolder | undefined> {
  const text = await commandOutput(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], false);
  if (text === "") {
    return undefined;
  }
  return parseLsof(text, port);
}

async function fuserPortHolder(port: number): Promise<PortHolder | undefined> {
  const pid = parseFuser(await commandOutput(["fuser", "-n", "tcp", String(port)], false), port);
  return pid === undefined ? undefined : { port, pid, command: "process" };
}

// psmisc fuser prints the pids on stdout and its "<port>/tcp:" label on
// stderr, so only stdout is parsed: with stderr mixed in, a holder fuser can't
// see (another user's process) or an error (macOS fuser has no `-n tcp`) left
// the port number as the only number, and it was reported as the pid. Some
// builds put the label on stdout; it is skipped, but a pid that happens to
// equal the port is still a real pid.
export function parseFuser(stdout: string, port: number): number | undefined {
  let text = stdout.trim();
  const label = `${port}/tcp:`;
  if (text.startsWith(label)) {
    text = text.slice(label.length);
  }
  for (const token of text.trim().split(/\s+/)) {
    if (/^\d+$/.test(token)) {
      const pid = Number(token);
      if (pid > 0) {
        return pid;
      }
    }
  }
  return undefined;
}

export function parseNetstat(text: string, port: number): PortHolder | undefined {
  const localSuffix = `:${port}`;
  for (const line of text.split("\n")) {
    if (!line.includes("LISTENING") && !line.includes("LISTEN")) {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    const local = parts[1] ?? "";
    if (!local.endsWith(localSuffix) && local !== String(port)) {
      continue;
    }
    const pid = Number(parts.at(-1));
    if (Number.isInteger(pid) && pid > 0) {
      return { port, pid, command: "process" };
    }
  }
  return undefined;
}

async function findPortHolderWindows(port: number): Promise<PortHolder | undefined> {
  const proc = spawn({
    cmd: ["netstat", "-ano"],
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = proc.stdout ? await new Response(proc.stdout).text() : "";
  await proc.exited;
  return parseNetstat(text, port);
}

const FREE_WAIT_MS = 400;

export type FreePortResult = "stopped" | "already-free";

export type FreePortDeps = {
  lookup?: (port: number) => Promise<PortHolder | undefined>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  waitMs?: number;
};

// Stops the process holding `holder.port`, but only while it is still
// `holder.pid`: the holder may have been looked up long before (a Doctor row
// the user acts on minutes later), and the pid may since have exited and been
// reused. Checked again before the follow-up SIGKILL, so a process that let
// go of the port on SIGTERM is left alone.
export async function freePort(holder: PortHolder, deps: FreePortDeps = {}): Promise<FreePortResult> {
  const lookup = deps.lookup ?? findPortHolder;
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => void process.kill(pid, signal));
  if (holder.pid === process.pid) {
    throw hintError(KindProcessStart, `port ${holder.port} is held by this TUI`, "stop the proxy from the proxy screen, or quit the TUI");
  }
  const current = await lookup(holder.port);
  if (!current) {
    return "already-free";
  }
  if (current.pid !== holder.pid) {
    throw hintError(
      KindProcessStart,
      `port ${holder.port} is now held by ${current.command} (pid ${current.pid}), not pid ${holder.pid}; not stopping it`,
      "refresh Doctor and check the new holder before freeing the port",
    );
  }
  try {
    kill(holder.pid, "SIGTERM");
  } catch (err) {
    throw wrapError(KindProcessStart, `could not stop pid ${holder.pid} on port ${holder.port}`, err);
  }
  await sleep(deps.waitMs ?? FREE_WAIT_MS);
  if ((await lookup(holder.port))?.pid !== holder.pid) {
    return "stopped";
  }
  try {
    kill(holder.pid, "SIGKILL");
  } catch {
    // exited between the check and the signal
  }
  return "stopped";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
