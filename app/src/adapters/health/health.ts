import * as http2 from "node:http2";
import { connect } from "node:net";
import { type HealthCheckConfig } from "../config/index.ts";
import { processAlive } from "../storage/storage.ts";
import { HealthHealthy, HealthUnhealthy, type ServiceHealth } from "../../domain/service/services.ts";
import type { HealthCheckerFactory } from "../../ports/health-checker.ts";

const DEFAULT_TIMEOUT_MS = 2_000;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 300;

export type HealthResult = {
  status: ServiceHealth;
  message: string;
};

export type HealthPlugin = {
  name: string;
  check: (
    cfg: HealthCheckConfig,
    ctx: { pid: number; ports: Record<string, number>; workDir: string; env: Record<string, string> },
  ) => Promise<{ status: string; message: string }>;
};

export function healthCheckerFactory(plugins: HealthPlugin[]): HealthCheckerFactory {
  return {
    lookup(type) {
      const kind = type.toLowerCase();
      const known = ["", "http", "tcp", "command", "process", "grpc"].includes(kind)
        || plugins.some((candidate) => candidate.name.toLowerCase() === kind);
      return known ? { check: (cfg, ctx) => checkHealth({ ...cfg, type }, ctx.pid, ctx.ports, ctx.workDir, ctx.env, plugins) } : undefined;
    },
  };
}

export async function checkHealth(
  cfg: HealthCheckConfig,
  pid: number,
  ports: Record<string, number>,
  workDir: string,
  env: Record<string, string>,
  plugins: HealthPlugin[] = [],
): Promise<HealthResult> {
  const timeout = cfg.timeout_seconds > 0 ? cfg.timeout_seconds * 1000 : DEFAULT_TIMEOUT_MS;
  const kind = cfg.type.toLowerCase();
  const plugin = plugins.find((item) => item.name.toLowerCase() === kind);
  if (plugin) {
    // A rejected plugin check is an unhealthy result for both direct
    // callers and the application health monitor.
    try {
      const res = await plugin.check(cfg, { pid, ports, workDir, env });
      return { status: res.status as ServiceHealth, message: res.message };
    } catch (err) {
      return { status: HealthUnhealthy, message: err instanceof Error ? err.message : String(err) };
    }
  }
  if (kind === "http") {
    return checkHTTP(cfg.url, timeout);
  }
  if (kind === "tcp") {
    return checkTCP(tcpAddress(cfg.address, ports), timeout);
  }
  if (kind === "grpc") {
    return checkGRPC(cfg.address, cfg.grpc_service ?? "", timeout);
  }
  if (kind === "command") {
    return checkCommand(cfg.command.args, cfg.command.shell, workDir, env, timeout);
  }
  if (kind === "process" || kind === "") {
    if (pid > 0 && processAlive(pid)) {
      return { status: HealthHealthy, message: "process running" };
    }
    return { status: HealthUnhealthy, message: "process not running" };
  }
  return { status: HealthUnhealthy, message: `unknown health type ${cfg.type}` };
}

async function checkHTTP(url: string, timeout: number): Promise<HealthResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (resp.status >= HTTP_OK_MIN && resp.status < HTTP_OK_MAX) {
      return { status: HealthHealthy, message: String(resp.status) };
    }
    return { status: HealthUnhealthy, message: String(resp.status) };
  } catch (err) {
    return { status: HealthUnhealthy, message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function tcpAddress(address: string, ports: Record<string, number>): string {
  if (address !== "") {
    return address;
  }
  if (ports.http !== undefined) {
    return `127.0.0.1:${ports.http}`;
  }
  const first = Object.values(ports)[0];
  return first !== undefined ? `127.0.0.1:${first}` : "";
}

function checkTCP(address: string, timeout: number): Promise<HealthResult> {
  return new Promise((resolve) => {
    if (address === "") {
      resolve({ status: HealthUnhealthy, message: "no tcp address" });
      return;
    }
    const separator = address.lastIndexOf(":");
    const port = Number.parseInt(address.slice(separator + 1), 10);
    const host = address.slice(0, separator).replace(/^\[|\]$/g, "");
    if (separator < 1 || !Number.isFinite(port)) {
      resolve({ status: HealthUnhealthy, message: `invalid tcp address ${address}` });
      return;
    }
    const socket = connect({ host, port }, () => {
      socket.end();
      resolve({ status: HealthHealthy, message: "connected" });
    });
    socket.setTimeout(timeout);
    socket.on("error", (err) => {
      resolve({ status: HealthUnhealthy, message: err.message });
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ status: HealthUnhealthy, message: "timeout" });
    });
  });
}

async function checkCommand(
  args: string[],
  shell: boolean,
  workDir: string,
  env: Record<string, string>,
  timeout: number,
): Promise<HealthResult> {
  if (args.length === 0) {
    return { status: HealthUnhealthy, message: "empty health command" };
  }
  const cmd = shell ? (process.platform === "win32" ? ["cmd.exe", "/c", args.join(" ")] : ["/bin/sh", "-c", args.join(" ")]) : args;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd,
      cwd: workDir === "" ? undefined : workDir,
      env,
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch (err) {
    // e.g. the command doesn't exist or workDir is invalid — a health check
    // that can't even start is unhealthy, not a crash of the check loop.
    return { status: HealthUnhealthy, message: err instanceof Error ? err.message : String(err) };
  }
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeout);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code === 0) {
    return { status: HealthHealthy, message: "ok" };
  }
  return { status: HealthUnhealthy, message: `exit ${code}` };
}

const GRPC_HEALTH_PATH = "/grpc.health.v1.Health/Check";
const GRPC_SERVING = 1;
const GRPC_NOT_SERVING = 2;
const GRPC_SERVICE_UNKNOWN = 3;

// grpc.health.v1.Health/Check over h2c, falling back to h2 (TLS) when the
// cleartext session is refused as a protocol error. SERVING is healthy;
// NOT_SERVING, SERVICE_UNKNOWN, UNKNOWN, and any RPC failure are not.
async function checkGRPC(address: string, service: string, timeout: number): Promise<HealthResult> {
  const target = parseHostPort(address);
  if (!target) {
    return { status: HealthUnhealthy, message: address === "" ? "no grpc address" : `invalid grpc address ${address}` };
  }
  const h2c = grpcHealthOrigin("http", target.host, target.port);
  try {
    return await grpcHealthCheck(h2c, service, timeout);
  } catch (h2cErr) {
    const h2cMessage = h2cErr instanceof Error ? h2cErr.message : String(h2cErr);
    if (!isTlsRetryable(h2cMessage)) {
      return { status: HealthUnhealthy, message: h2cMessage };
    }
    try {
      return await grpcHealthCheck(grpcHealthOrigin("https", target.host, target.port), service, timeout);
    } catch (h2Err) {
      return { status: HealthUnhealthy, message: h2Err instanceof Error ? h2Err.message : String(h2Err) };
    }
  }
}

function isTlsRetryable(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("http2") || lower.includes("ssl") || lower.includes("tls") || lower.includes("eproto") || lower.includes("protocol");
}

export function grpcHealthOrigin(scheme: "http" | "https", host: string, port: number): string {
  const authority = host.includes(":") ? `[${host}]` : host;
  return `${scheme}://${authority}:${port}`;
}

function parseHostPort(address: string): { host: string; port: number } | undefined {
  if (address === "") {
    return undefined;
  }
  const separator = address.lastIndexOf(":");
  const port = Number.parseInt(address.slice(separator + 1), 10);
  const host = address.slice(0, separator).replace(/^\[|\]$/g, "");
  if (separator < 1 || !Number.isFinite(port)) {
    return undefined;
  }
  return { host, port };
}

function grpcHealthCheck(origin: string, service: string, timeout: number): Promise<HealthResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | undefined, result?: HealthResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      session.close();
      if (err) {
        reject(err);
        return;
      }
      resolve(result ?? { status: HealthUnhealthy, message: "empty grpc health response" });
    };
    const session = http2.connect(origin);
    const timer = setTimeout(() => {
      session.destroy();
      finish(new Error("timeout"));
    }, timeout);
    session.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
    session.on("connect", () => {
      const req = session.request({
        ":method": "POST",
        ":path": GRPC_HEALTH_PATH,
        "content-type": "application/grpc",
        te: "trailers",
      });
      const chunks: Buffer[] = [];
      let httpStatus = 0;
      let grpcStatus = "";
      let grpcMessage = "";
      req.on("response", (headers) => {
        httpStatus = Number(headers[":status"] ?? 0);
        if (headers["grpc-status"] !== undefined) {
          grpcStatus = String(headers["grpc-status"]);
        }
        if (headers["grpc-message"] !== undefined) {
          grpcMessage = String(headers["grpc-message"]);
        }
      });
      req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on("trailers", (trailers) => {
        if (trailers["grpc-status"] !== undefined) {
          grpcStatus = String(trailers["grpc-status"]);
        }
        if (trailers["grpc-message"] !== undefined) {
          grpcMessage = String(trailers["grpc-message"]);
        }
      });
      req.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
      req.on("end", () => {
        if (httpStatus !== 0 && httpStatus !== 200) {
          finish(undefined, { status: HealthUnhealthy, message: `http ${httpStatus}` });
          return;
        }
        if (grpcStatus !== "" && grpcStatus !== "0") {
          finish(undefined, { status: HealthUnhealthy, message: grpcMessage || `grpc-status ${grpcStatus}` });
          return;
        }
        finish(undefined, interpretHealthStatus(decodeHealthStatus(Buffer.concat(chunks))));
      });
      req.end(grpcFrame(encodeHealthCheckRequest(service)));
    });
  });
}

function interpretHealthStatus(status: number | undefined): HealthResult {
  if (status === GRPC_SERVING) {
    return { status: HealthHealthy, message: "SERVING" };
  }
  if (status === GRPC_NOT_SERVING) {
    return { status: HealthUnhealthy, message: "NOT_SERVING" };
  }
  if (status === GRPC_SERVICE_UNKNOWN) {
    return { status: HealthUnhealthy, message: "SERVICE_UNKNOWN" };
  }
  if (status === 0) {
    return { status: HealthUnhealthy, message: "UNKNOWN" };
  }
  return { status: HealthUnhealthy, message: status === undefined ? "empty grpc health response" : `status ${status}` };
}

function grpcFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function encodeHealthCheckRequest(service: string): Buffer {
  if (service === "") {
    return Buffer.alloc(0);
  }
  const name = Buffer.from(service, "utf8");
  return Buffer.concat([Buffer.from([0x0a]), encodeVarint(name.length), name]);
}

function decodeHealthStatus(body: Buffer): number | undefined {
  if (body.length < 5) {
    return undefined;
  }
  const length = body.readUInt32BE(1);
  const payload = body.subarray(5, 5 + length);
  let offset = 0;
  while (offset < payload.length) {
    const tag = payload[offset] ?? 0;
    offset += 1;
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 0) {
      return readVarint(payload, offset).value;
    }
    if (wire === 0) {
      offset = readVarint(payload, offset).next;
    } else if (wire === 2) {
      const len = readVarint(payload, offset);
      offset = len.next + len.value;
    } else {
      return undefined;
    }
  }
  return 0;
}

function encodeVarint(value: number): Buffer {
  if (value < 0x80) {
    return Buffer.from([value]);
  }
  const bytes: number[] = [];
  let n = value;
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i] ?? 0;
    i += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, next: i };
    }
    shift += 7;
  }
  return { value, next: i };
}
