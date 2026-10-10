// Host side of the Docker soak suite: builds the soak image once per run and
// drives devctl inside containers shaped like a dev container (a 2 GiB
// memory limit, PID 1 `sleep infinity`, or Docker's init with `init: true`).
//
// Gated by DEVCTL_SOAK=1. DEVCTL_SOAK_QUICK=1 runs the PR subset.
// Measurements happen inside the container (driver/probe.ts), because a
// `docker exec` per sample costs more than the latency budgets measured.
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, relative } from "node:path";

export const soakEnabled = process.env.DEVCTL_SOAK === "1";
export const soakQuick = process.env.DEVCTL_SOAK_QUICK === "1";

/** The image build, on a cold cache: bun install plus a compile. */
export const IMAGE_BUILD_TIMEOUT_MS = 15 * 60_000;

const APP_DIR = join(import.meta.dir, "..", "..", "..");
const DOCKERFILE = join(import.meta.dir, "Dockerfile");
const RUN_ID = `${process.pid}-${Date.now().toString(36)}`;
const REPO = "/work/repo";

export type RunResult = { code: number; stdout: string; stderr: string };

export async function run(cmd: string[], opts: { input?: string; timeoutMs?: number; allowFail?: boolean; cwd?: string } = {}): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0 && opts.allowFail !== true) {
    throw new Error(`${cmd.join(" ")} exited ${code}\nstdout:\n${stdout.slice(-4000)}\nstderr:\n${stderr.slice(-4000)}`);
  }
  return { code, stdout, stderr };
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".watch-")) {
      continue;
    }
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
}

/** A tag that changes whenever anything the image is built from changes. */
function imageTag(): string {
  const files = [
    DOCKERFILE,
    `${DOCKERFILE}.dockerignore`,
    ...["package.json", "bun.lock", "bunfig.toml", "tsconfig.json"].map((name) => join(APP_DIR, name)),
  ];
  walk(join(APP_DIR, "src"), files);
  walk(join(import.meta.dir, "driver"), files);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(relative(APP_DIR, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return `devctl-soak:${hash.digest("hex").slice(0, 16)}`;
}

let image: Promise<string> | undefined;

/** Builds (or reuses) the soak image from this checkout. */
export function soakImage(): Promise<string> {
  image ??= (async () => {
    const tag = imageTag();
    const existing = await run(["docker", "image", "inspect", "--format", "{{.Id}}", tag], { allowFail: true });
    if (existing.code === 0) {
      return tag;
    }
    await run(["docker", "build", "-f", DOCKERFILE, "-t", tag, "--label", "devctl-soak=1", APP_DIR], { timeoutMs: IMAGE_BUILD_TIMEOUT_MS });
    return tag;
  })();
  return image;
}

export type OldDevctl = {
  /** The compiled binary on this host, to copy into a container. */
  path: string;
  ref: string;
  version: string;
};

let old: Promise<OldDevctl | undefined> | undefined;

/**
 * devctl compiled from an older ref, for the version-skew scenario:
 * DEVCTL_SOAK_OLD_REF, else origin/main, else main. Undefined when this
 * clone has none of them.
 */
export function oldDevctl(): Promise<OldDevctl | undefined> {
  old ??= (async () => {
    const repo = join(APP_DIR, "..");
    const wanted = process.env.DEVCTL_SOAK_OLD_REF;
    let ref = "";
    let sha = "";
    for (const candidate of wanted !== undefined && wanted !== "" ? [wanted] : ["origin/main", "main"]) {
      const found = await run(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { allowFail: true });
      if (found.code === 0) {
        ref = candidate;
        sha = found.stdout.trim();
        break;
      }
    }
    if (sha === "") {
      return undefined;
    }
    const manifest = await run(["git", "-C", repo, "show", `${sha}:app/package.json`]);
    const version = (JSON.parse(manifest.stdout) as { version: string }).version;
    const recipe = createHash("sha256").update(readFileSync(`${DOCKERFILE}.old`)).digest("hex").slice(0, 8);
    const tag = `devctl-soak-old:${sha.slice(0, 12)}-${recipe}`;
    const existing = await run(["docker", "image", "inspect", "--format", "{{.Id}}", tag], { allowFail: true });
    if (existing.code !== 0) {
      const context = mkdtempSync(join(tmpdir(), "devctl-soak-old-"));
      await run(["git", "-C", repo, "archive", "--format=tar", "-o", join(context, "tree.tar"), sha, "app/package.json", "app/bun.lock", "app/bunfig.toml", "app/tsconfig.json", "app/src"]);
      await run(["tar", "-xf", join(context, "tree.tar"), "-C", context]);
      await run(["docker", "build", "-f", `${DOCKERFILE}.old`, "-t", tag, "--label", "devctl-soak=1", "--build-arg", `DEVCTL_VERSION=${version}`, context], { timeoutMs: IMAGE_BUILD_TIMEOUT_MS });
    }
    const out = mkdtempSync(join(tmpdir(), "devctl-soak-oldbin-"));
    const holder = `devctl-soak-old-${RUN_ID}`;
    await run(["docker", "create", "--name", holder, tag, "/devctl"]);
    try {
      await run(["docker", "cp", `${holder}:/devctl`, join(out, "devctl-old")]);
    } finally {
      await run(["docker", "rm", "-f", holder], { allowFail: true });
    }
    return { path: join(out, "devctl-old"), ref, version };
  })();
  return old;
}

export type ContainerShape = {
  /** Docker's init as PID 1 instead of `sleep infinity`. */
  init?: boolean;
  memory?: string;
};

let containerCount = 0;

/** One dev-container-shaped container with a repository at /work/repo. */
export class SoakContainer {
  private constructor(
    readonly name: string,
    readonly shape: ContainerShape,
  ) {}

  static async start(tag: string, shape: ContainerShape = {}): Promise<SoakContainer> {
    containerCount += 1;
    const name = `devctl-soak-${RUN_ID}-${containerCount}`;
    const memory = shape.memory ?? "2g";
    await run([
      "docker", "run", "-d", "--name", name, "--label", `devctl-soak.run=${RUN_ID}`,
      "--memory", memory, "--memory-swap", memory,
      ...(shape.init === true ? ["--init"] : []),
      tag, "sleep", "infinity",
    ]);
    const container = new SoakContainer(name, shape);
    try {
      await container.sh(`mkdir -p ${REPO}/.devctl`, { cwd: "/work" });
    } catch (err) {
      // Not yet handed to a test's cleanup list, so it would be left running.
      await container.rm();
      throw err;
    }
    return container;
  }

  exec(cmd: string[], opts: { env?: Record<string, string>; input?: string; timeoutMs?: number; allowFail?: boolean; cwd?: string } = {}): Promise<RunResult> {
    const env = Object.entries(opts.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    // `cwd` is inside the container; the docker client itself runs wherever the test does.
    return run(["docker", "exec", ...(opts.input === undefined ? [] : ["-i"]), "-w", opts.cwd ?? REPO, ...env, this.name, ...cmd], {
      input: opts.input,
      timeoutMs: opts.timeoutMs,
      allowFail: opts.allowFail,
    });
  }

  sh(script: string, opts: { env?: Record<string, string>; input?: string; timeoutMs?: number; allowFail?: boolean; cwd?: string } = {}): Promise<RunResult> {
    return this.exec(["sh", "-c", script], opts);
  }

  async write(path: string, content: string): Promise<void> {
    await this.exec(["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path], { input: content });
  }

  /** `devctl` in the repository. */
  devctl(args: string[], opts: { env?: Record<string, string>; timeoutMs?: number; allowFail?: boolean; cwd?: string } = {}): Promise<RunResult> {
    return this.exec(["devctl", ...args], opts);
  }

  /** A driver script from harness/driver, run with the image's bun; its stdout is one JSON object. */
  async driver<T>(script: string, args: string[] = [], opts: { timeoutMs?: number; allowFail?: boolean; input?: string } = {}): Promise<T> {
    const out = await this.exec(["bun", `/soak/driver/${script}`, ...args], opts);
    const line = out.stdout.trim().split("\n").at(-1) ?? "";
    try {
      return JSON.parse(line) as T;
    } catch {
      throw new Error(`${script} printed no JSON (exit ${out.code})\nstdout:\n${out.stdout.slice(-2000)}\nstderr:\n${out.stderr.slice(-2000)}`);
    }
  }

  /** Writes .devctl/config.yaml and requires `devctl config validate` to pass. */
  async configure(yaml: string, repo = REPO): Promise<void> {
    await this.write(`${repo}/.devctl/config.yaml`, yaml);
    const validate = await this.devctl(["config", "validate"], { allowFail: true, cwd: repo });
    if (validate.code !== 0) {
      throw new Error(`devctl config validate failed:\n${validate.stdout}${validate.stderr}`);
    }
  }

  async status(repo = REPO): Promise<DaemonStatus> {
    return JSON.parse((await this.devctl(["status", "--json"], { cwd: repo })).stdout) as DaemonStatus;
  }

  /** The state directory of the stack started from `repo`. */
  async stateDir(): Promise<string> {
    const out = await this.sh('ls -d "$DEVCTL_HOME"/state/*/ | head -1');
    return out.stdout.trim().replace(/\/$/, "");
  }

  async daemonPid(): Promise<number> {
    const dir = await this.stateDir();
    const lock = JSON.parse((await this.exec(["cat", `${dir}/devctl.lock`])).stdout) as { pid: number };
    return lock.pid;
  }

  /** Waits until `service` has logged its `done` line and the daemon took in everything after it. */
  async waitDone(service: string, opts: { search?: string; timeoutMs?: number; cwd?: string; stateDir?: string } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 180_000;
    const state = opts.stateDir === undefined ? [] : ["--state-dir", opts.stateDir];
    await this.exec(["bun", "/soak/driver/wait.ts", "--service", service, "--search", opts.search ?? `${service} done`, "--timeout-ms", String(timeoutMs), ...state], { timeoutMs: timeoutMs + 20_000, cwd: opts.cwd });
  }

  /** The gap-free check over the persisted session(s) `ids`, oldest first. */
  verifySessions(ids: string[], name: string, count: number, logsRoot = "/work/home/logs"): Promise<VerifyResult> {
    const dirs = ids.map((id) => `${logsRoot}/session-${id}`).join(",");
    return this.driver<VerifyResult>("verify.ts", ["--session-dir", dirs, "--name", name, "--count", String(count)], { timeoutMs: 180_000 });
  }

  /** The gap-free check over what `devctl logs <name> --all` returns. */
  async verifyListed(name: string, count: number, cwd = REPO): Promise<VerifyResult> {
    const out = await this.exec(["sh", "-c", `devctl logs ${name} --all --json | bun /soak/driver/verify.ts --stdin --name ${name} --count ${count}`], { timeoutMs: 180_000, cwd });
    return JSON.parse(out.stdout.trim().split("\n").at(-1) ?? "{}") as VerifyResult;
  }

  /** The `elapsed_ms` a flood service printed with its `done` line. */
  async floodElapsedMs(name: string, cwd = REPO): Promise<number> {
    const out = await this.devctl(["logs", name, "--search", `${name} done`, "--json"], { cwd });
    const match = /elapsed_ms=(\d+)/.exec(out.stdout);
    return match === null ? Number.NaN : Number(match[1]);
  }

  /** Copies a file from this host to `path` in the container, executable. */
  async install(hostPath: string, path: string): Promise<void> {
    await run(["docker", "cp", hostPath, `${this.name}:${path}`]);
    await this.sh(`chmod 755 ${path}`, { cwd: "/work" });
  }

  async rm(): Promise<void> {
    await run(["docker", "rm", "-f", this.name], { allowFail: true });
  }
}

/** A flood service's YAML, indented under `services:`. */
export function floodService(name: string, rate: number, count: number, extra: { width?: number; stderr?: boolean } = {}): string {
  const args = ["--rate", String(rate), "--count", String(count), "--name", name];
  if (extra.width !== undefined) {
    args.push("--width", String(extra.width));
  }
  if (extra.stderr === true) {
    args.push("--stderr");
  }
  return `  ${name}:
    command: [bun, /soak/driver/flood.ts, ${args.map((arg) => JSON.stringify(arg)).join(", ")}]
    restart: { policy: never }
`;
}

export const CONFIG_HEADER = `# yaml-language-server: $schema=https://raw.githubusercontent.com/amr-m-abdelgawad/devctl/main/schema/devctl.config.schema.json
version: 1
`;

export type DaemonStatus = {
  session_id: string;
  services: Record<string, { state: string; pid: number; health: string }>;
  logs: { total: number; seen: number; counts: Record<string, number> };
  daemon?: {
    rssBytes: number;
    logStore?: string;
    watchdog?: string;
    nonReapingPid1?: boolean;
    logs?: { inFlightBytes: number; spooledBytes: number; paused: boolean; loss: number; degraded?: string };
  };
};

export type ProbeResult = {
  rpc: Latency & { errors: number };
  proxy?: Latency & { errors: number };
  rss: { maxBytes: number; lastBytes: number; samples: number };
  pipeline: { maxSpooledBytes: number; maxInFlightBytes: number; pausedSamples: number; maxLoss: number; degraded: string[]; samples: number; statusErrors: number };
  daemon: { pid: number; session?: string; logStore?: string; watchdog?: string; maxEventLoopLagMs: number; seen?: number };
  events: number;
  load: { start: number[]; end: number[] };
  diskFreeBytes: number;
};

export type Latency = { count: number; p50: number; p99: number; max: number };

export type VerifyResult = {
  files: string[];
  records: number;
  first: number;
  last: number;
  count: number;
  complete: boolean;
  contiguousTail: boolean;
  missingInside: number;
  missingSample: number[];
  duplicates: number;
  outOfOrder: number;
  done: boolean;
  lagMs: Latency;
  bodyChars: { min: number; max: number };
};

/** The host's own load, recorded next to each measurement: other suites may share this machine. */
export function hostLoad(): number[] {
  return loadavg().map((value) => Math.round(value * 100) / 100);
}

/** Prints a scenario's numbers so a run's log carries them, pass or fail. */
export function report(scenario: string, numbers: Record<string, unknown>): void {
  console.log(`[soak] ${scenario} ${JSON.stringify({ ...numbers, hostLoad: hostLoad() })}`);
}

export const MIB = 1024 * 1024;
