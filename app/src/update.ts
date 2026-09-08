import { realpathSync } from "node:fs";
import { VERSION } from "./version.ts";

const RELEASES_URL = "https://api.github.com/repos/amr-m-abdelgawad/devctl/releases/latest";
export const NPM_PACKAGE = "@amr-m-abdelgawad/devctl";
export const HOMEBREW_FORMULA_URL =
  "https://raw.githubusercontent.com/amr-m-abdelgawad/devctl/main/homebrew/devctl.rb";
export const DAEMON_RESTART_HINT = "restart the daemon with `devctl down` then start again";

const NPM_PACKAGE_DIR = "/@amr-m-abdelgawad/devctl/";
const NPX_CACHE_DIR = "/_npx/";
const SOURCE_ENTRY = "/src/bin.ts";
const HOMEBREW_CELLAR = "/cellar/devctl/";

export type InstallKind = "npm" | "npx" | "homebrew" | "release" | "source" | "unknown";

export type InstallChannel = {
  kind: InstallKind;
  /** argv to run when this channel can self-update. */
  command?: string[];
  hint: string;
};

export type UpdateCheck = {
  current: string;
  latest: string;
  newer: boolean;
  hint: string;
  kind: InstallKind;
  command?: string[];
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type SpawnInstall = (command: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export function formatUpdateStatus(result: UpdateCheck): string {
  if (result.newer) {
    return `update available ${result.current} → ${result.latest}  ${result.hint}`;
  }
  if (result.latest !== "") {
    return `${result.current} up to date`;
  }
  return `${result.current} (latest unavailable)`;
}

export function detectInstall(input: {
  scriptPath: string;
  execPath: string;
  standalone: boolean;
}): InstallChannel {
  const script = posixPath(input.scriptPath);
  const exec = posixPath(input.execPath);
  if (!input.standalone && script.includes(NPM_PACKAGE_DIR)) {
    if (script.includes(NPX_CACHE_DIR)) {
      return { kind: "npx", hint: `npx ${NPM_PACKAGE}@latest` };
    }
    const command = npmInstallCommand();
    return { kind: "npm", command, hint: command.join(" ") };
  }
  if (input.standalone && exec.toLowerCase().includes(HOMEBREW_CELLAR)) {
    return {
      kind: "homebrew",
      command: ["brew", "reinstall", "--formula", HOMEBREW_FORMULA_URL],
      hint: `brew reinstall --formula ${HOMEBREW_FORMULA_URL}`,
    };
  }
  if (input.standalone) {
    return {
      kind: "release",
      hint: "re-download the matching GitHub Release binary — see docs/installation.md",
    };
  }
  if (script.endsWith(SOURCE_ENTRY)) {
    return { kind: "source", hint: "git pull && cd app && bun install" };
  }
  return {
    kind: "unknown",
    hint: `npm install --global ${NPM_PACKAGE}@latest  # alternatives: Homebrew or the unsigned GitHub Release binaries — see docs/installation.md`,
  };
}

export function runningInstall(): InstallChannel {
  const standalone = Bun.isStandaloneExecutable === true;
  const scriptPath = standalone ? "" : resolvePath(process.argv[1] ?? "");
  return detectInstall({
    scriptPath,
    execPath: resolvePath(process.execPath),
    standalone,
  });
}

export async function checkUpdate(fetchFn: FetchLike = fetch, channel: InstallChannel = runningInstall()): Promise<UpdateCheck> {
  try {
    const resp = await fetchFn(RELEASES_URL, { headers: { Accept: "application/vnd.github+json" } });
    if (!resp.ok) {
      return unavailable(channel);
    }
    const body = (await resp.json()) as { tag_name?: string };
    const latest = (body.tag_name ?? "").replace(/^v/, "");
    return {
      current: VERSION,
      latest,
      newer: latest !== "" && compareSemver(latest, VERSION) > 0,
      hint: channel.hint,
      kind: channel.kind,
      command: channel.command,
    };
  } catch {
    return unavailable(channel);
  }
}

export async function applyInstall(
  command: readonly string[],
  spawnFn: SpawnInstall = spawnInstall,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return spawnFn(command);
}

export async function spawnInstall(
  command: readonly string[],
  inherit = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([...command], {
    stdout: inherit ? "inherit" : "pipe",
    stderr: inherit ? "inherit" : "pipe",
    stdin: "ignore",
  });
  if (inherit) {
    return { code: await proc.exited, stdout: "", stderr: "" };
  }
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}

function unavailable(channel: InstallChannel): UpdateCheck {
  return {
    current: VERSION,
    latest: "",
    newer: false,
    hint: channel.hint,
    kind: channel.kind,
    command: channel.command,
  };
}

function npmInstallCommand(): string[] {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return [npm, "install", "--global", `${NPM_PACKAGE}@latest`];
}

function posixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function resolvePath(value: string): string {
  if (value === "") {
    return "";
  }
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

function parseSemver(value: string): number[] {
  return value
    .replace(/^v/, "")
    .split(".")
    .slice(0, 3)
    .map((part) => {
      const n = Number.parseInt(part.replace(/[^0-9].*$/, ""), 10);
      return Number.isFinite(n) ? n : 0;
    });
}
