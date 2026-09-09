import { realpathSync } from "node:fs";
import { VERSION } from "../../version.ts";
import { compareSemver, detectInstall, type InstallChannel, type UpdateCheck } from "../../domain/update.ts";
import type { UpdateApplyResult, UpdateChecker, UpdateInstaller } from "../../ports/update.ts";

const RELEASES_URL = "https://api.github.com/repos/amr-m-abdelgawad/devctl/releases/latest";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type SpawnInstall = (command: readonly string[]) => Promise<UpdateApplyResult>;

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
): Promise<UpdateApplyResult> {
  return spawnFn(command);
}

export async function spawnInstall(
  command: readonly string[],
  inherit = false,
): Promise<UpdateApplyResult> {
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

export function githubUpdate(fetchFn: FetchLike = fetch): UpdateChecker & UpdateInstaller {
  return {
    check: () => checkUpdate(fetchFn),
    apply: (command, inherit) => (inherit === true ? spawnInstall(command, true) : applyInstall(command)),
  };
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
