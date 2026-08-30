import { connect } from "node:net";
import { type HealthCheckConfig } from "./config/index.ts";
import { processAlive } from "./storage.ts";
import { HealthHealthy, HealthUnhealthy, type ServiceHealth } from "./services.ts";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_INTERVAL_MS = 2_000;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 300;

export type HealthResult = {
  status: ServiceHealth;
  message: string;
};

export function healthIntervalMs(cfg: HealthCheckConfig): number {
  if (cfg.interval_seconds <= 0) {
    return DEFAULT_INTERVAL_MS;
  }
  return cfg.interval_seconds * 1000;
}

export type HealthPlugin = {
  name: string;
  check: (
    cfg: HealthCheckConfig,
    ctx: { pid: number; ports: Record<string, number>; workDir: string; env: Record<string, string> },
  ) => Promise<{ status: string; message: string }>;
};

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
    const res = await plugin.check(cfg, { pid, ports, workDir, env });
    return { status: res.status as ServiceHealth, message: res.message };
  }
  if (kind === "http") {
    return checkHTTP(cfg.url, timeout);
  }
  if (kind === "tcp") {
    return checkTCP(tcpAddress(cfg.address, ports), timeout);
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
    const socket = connect(address, () => {
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
  const proc = Bun.spawn({
    cmd,
    cwd: workDir === "" ? undefined : workDir,
    env,
    stdout: "ignore",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeout);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code === 0) {
    return { status: HealthHealthy, message: "ok" };
  }
  return { status: HealthUnhealthy, message: `exit ${code}` };
}

export function healthLevel(status: ServiceHealth): string {
  if (status === HealthUnhealthy) {
    return "WARN";
  }
  if (status === HealthHealthy) {
    return "INFO";
  }
  return "DEBUG";
}
