// Shared helpers for the end-to-end scenarios: a throwaway repository with
// its own DEVCTL_HOME, driven through the real CLI and daemon.
//
// Gated by DEVCTL_E2E=1 (see docs/internals/testing-ci.md). The CLI under
// test is `bun src/bin.ts` unless DEVCTL_E2E_BIN names a compiled binary.

import { describe } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { processAlive, readRepoLock } from "../src/adapters/storage/storage.ts";

export const e2eEnabled = process.env.DEVCTL_E2E === "1";

/** `describe`, or `describe.skip` unless DEVCTL_E2E=1. */
export const describeE2E = e2eEnabled ? describe : describe.skip;

export const E2E_DIR = import.meta.dir;
export const FIXTURES_DIR = join(E2E_DIR, "fixtures");
/** Interpreter of the virtualenv e2e/setup.sh creates. */
export const PYTHON_BIN = join(E2E_DIR, ".deps", "venv", "bin", "python");

/** Per-test timeout: scenarios start real processes. */
export const SCENARIO_TIMEOUT_MS = 90_000;

const CLI_TIMEOUT_MS = 60_000;
const EXIT_WAIT_MS = 5_000;

export type CliResult = { code: number; stdout: string; stderr: string };

export type ServiceStatus = {
  name: string;
  state: string;
  health: string;
  pid: number;
  ports: Record<string, number>;
  last_error: string;
};

export type StatusSnapshot = { services: Record<string, ServiceStatus> };

export type LogRecord = {
  service: string;
  source: string;
  body: unknown;
  severityText?: string;
  traceId?: string;
  spanId?: string;
  attributes: Record<string, unknown>;
  raw?: string;
};

function cliCommand(): string[] {
  const bin = process.env.DEVCTL_E2E_BIN;
  return bin ? [bin] : [process.execPath, join(E2E_DIR, "..", "src", "bin.ts")];
}

export class Sandbox {
  /** The repository root. */
  readonly dir: string;
  /** DEVCTL_HOME for this sandbox only. */
  readonly home: string;
  private readonly root: string;
  private readonly pids = new Set<number>();

  private constructor(root: string, home?: string) {
    this.root = root;
    this.dir = join(root, "repo");
    this.home = home ?? join(root, "h");
    mkdirSync(join(this.dir, ".devctl"), { recursive: true });
    mkdirSync(this.home, { recursive: true });
  }

  /**
   * A fresh repository with `files` written relative to its root. `home`
   * shares one DEVCTL_HOME between sandboxes (parallel checkouts on one
   * machine); the caller removes it.
   */
  static create(name: string, files: Record<string, string> = {}, opts: { home?: string } = {}): Sandbox {
    // Rooted at /tmp, not $TMPDIR: the daemon socket lives at
    // $DEVCTL_HOME/state/<repo id>/devctl.sock, and macOS's long
    // /var/folders/... TMPDIR would push it past the 104-byte socket limit.
    const root = mkdtempSync(join("/tmp", `dctl-${name.slice(0, 12)}-`));
    const sandbox = new Sandbox(root, opts.home);
    // Some commands (config import) resolve the repository via git.
    Bun.spawnSync(["git", "init", "-q", sandbox.dir], { stdout: "ignore", stderr: "ignore" });
    for (const [path, content] of Object.entries(files)) {
      sandbox.write(path, content);
    }
    return sandbox;
  }

  write(path: string, content: string): void {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  /** Runs the devctl CLI in this repository. Throws on a non-zero exit unless `allowFail`. */
  async cli(args: string[], opts: { allowFail?: boolean } = {}): Promise<CliResult> {
    const proc = Bun.spawn([...cliCommand(), ...args], {
      cwd: this.dir,
      env: { ...process.env, DEVCTL_HOME: this.home, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), CLI_TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    if (code !== 0 && !opts.allowFail) {
      throw new Error(`devctl ${args.join(" ")} exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    return { code, stdout, stderr };
  }

  /** `devctl start …`, then records the supervisor and service pids for the leak check in down(). */
  async start(services: string[]): Promise<void> {
    await this.cli(["start", ...services]);
    await this.trackPids();
  }

  async status(): Promise<StatusSnapshot> {
    const out = await this.cli(["status", "--json"]);
    const snapshot = JSON.parse(out.stdout) as StatusSnapshot;
    for (const svc of Object.values(snapshot.services)) {
      if (svc.pid > 0) {
        this.pids.add(svc.pid);
      }
    }
    return snapshot;
  }

  async logs(args: string[] = []): Promise<LogRecord[]> {
    const out = await this.cli(["logs", "--json", ...args]);
    return out.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as LogRecord);
  }

  /**
   * Teardown: `devctl down`, then fail if the supervisor or any service it
   * started is still running (they are killed first so nothing leaks past
   * the test). Removes the sandbox.
   */
  async down(): Promise<void> {
    await this.trackPids().catch(() => undefined);
    await this.cli(["down"], { allowFail: true });
    const deadline = Date.now() + EXIT_WAIT_MS;
    let alive = [...this.pids].filter((pid) => processAlive(pid));
    while (alive.length > 0 && Date.now() < deadline) {
      await Bun.sleep(100);
      alive = alive.filter((pid) => processAlive(pid));
    }
    for (const pid of alive) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    rmSync(this.root, { recursive: true, force: true });
    if (alive.length > 0) {
      throw new Error(`processes still running after devctl down: ${alive.join(", ")}`);
    }
  }

  private async trackPids(): Promise<void> {
    const supervisor = this.supervisorPid();
    if (supervisor > 0) {
      this.pids.add(supervisor);
    }
    await this.status();
  }

  private supervisorPid(): number {
    // readRepoLock resolves the lock under $DEVCTL_HOME at call time.
    const previous = process.env.DEVCTL_HOME;
    process.env.DEVCTL_HOME = this.home;
    try {
      return readRepoLock(this.dir)?.pid ?? 0;
    } finally {
      if (previous === undefined) {
        delete process.env.DEVCTL_HOME;
      } else {
        process.env.DEVCTL_HOME = previous;
      }
    }
  }
}

/** Polls `probe` until it returns a value that isn't false/undefined, or throws with `what`. */
export async function waitFor<T>(what: string, probe: () => Promise<T | false | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== false && value !== undefined) {
        return value;
      }
    } catch (err) {
      lastError = err;
    }
    await Bun.sleep(250);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`timed out waiting for ${what}${suffix}`);
}

/** The text of a log record's body, whatever its shape. */
export function bodyText(record: LogRecord): string {
  return typeof record.body === "string" ? record.body : JSON.stringify(record.body);
}
