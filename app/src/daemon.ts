import { readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { discover } from "./config/discover.ts";
import { homeDir, readPersistedStateFile } from "./storage.ts";

// A deleted .devctl directory must never make a live daemon unreachable:
// normal discovery only finds a repo by its config file, so once that file
// is gone, discovery has nothing to walk up from. This scans every
// repo-state directory this user owns (~/.devctl/state/<repoID>/state.json)
// for a repo_root that is the target directory or one of its ancestors,
// independent of whether that directory still has a .devctl in it.
export function scanStateDirsForRepoRoot(targetDir: string): string | undefined {
  const stateRoot = join(homeDir(), "state");
  let entries: string[];
  try {
    entries = readdirSync(stateRoot);
  } catch {
    return undefined;
  }
  const target = normalize(resolve(targetDir));
  let best: string | undefined;
  for (const entry of entries) {
    const persisted = readPersistedStateFile(join(stateRoot, entry, "state.json"));
    if (!persisted) {
      continue;
    }
    const candidate = normalize(resolve(persisted.repo_root));
    if (!isSelfOrAncestor(candidate, target)) {
      continue;
    }
    if (!best || candidate.length > best.length) {
      best = candidate;
    }
  }
  return best;
}

export type DaemonTargetSource = "explicit" | "config" | "state-scan";

export type DaemonTarget = {
  repoRoot: string;
  source: DaemonTargetSource;
};

// The single resolution path attach, status, daemon-log access, and `down`
// all share: an explicit --repo wins outright; otherwise prefer normal
// .devctl discovery (it also confirms a config file actually exists there);
// only fall back to the state-directory scan when that fails, since a live
// daemon can outlive the config that started it.
export function resolveDaemonTarget(startDir: string, explicitRepo: string): DaemonTarget | undefined {
  if (explicitRepo !== "") {
    return { repoRoot: resolve(explicitRepo), source: "explicit" };
  }
  const cwd = startDir === "" ? process.cwd() : startDir;
  try {
    const { repoRoot } = discover(cwd, "");
    return { repoRoot, source: "config" };
  } catch {
    // fall through to the state-directory scan below
  }
  const scanned = scanStateDirsForRepoRoot(cwd);
  return scanned ? { repoRoot: scanned, source: "state-scan" } : undefined;
}

function normalize(path: string): string {
  const withoutTrailingSep = path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
  return process.platform === "win32" ? withoutTrailingSep.toLowerCase() : withoutTrailingSep;
}

function isSelfOrAncestor(candidateRoot: string, target: string): boolean {
  return target === candidateRoot || target.startsWith(candidateRoot.endsWith(sep) ? candidateRoot : `${candidateRoot}${sep}`);
}
