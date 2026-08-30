import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { hintError, KindConfiguration, wrapError } from "../errors.ts";

export const ConfigDirName = ".devctl";
export const ConfigFileName = "config.yaml";

export function discover(startDir: string, explicit: string): { repoRoot: string; configPath: string } {
  if (explicit !== "") {
    return discoverExplicit(explicit);
  }
  let dir = startDir === "" ? process.cwd() : startDir;
  dir = isAbsolute(dir) ? dir : resolve(dir);
  for (;;) {
    const candidateFile = join(dir, ConfigDirName, ConfigFileName);
    if (fileExists(candidateFile)) {
      return { repoRoot: dir, configPath: candidateFile };
    }
    const single = join(dir, "devctl.yaml");
    if (fileExists(single)) {
      return { repoRoot: dir, configPath: single };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw hintError(
    KindConfiguration,
    "no devctl configuration found",
    "run `devctl setup` or create a .devctl/config.yaml in the repository root",
  );
}

function discoverExplicit(explicit: string): { repoRoot: string; configPath: string } {
  const abs = resolve(explicit);
  let info;
  try {
    info = statSync(abs);
  } catch (err) {
    throw wrapError(KindConfiguration, "config path not found", err);
  }
  if (info.isDirectory()) {
    const cfg = join(abs, ConfigFileName);
    if (fileExists(cfg)) {
      return { repoRoot: abs, configPath: cfg };
    }
    if (abs.endsWith(ConfigDirName) || abs.split("/").pop() === ConfigDirName) {
      return { repoRoot: dirname(abs), configPath: cfg };
    }
    return { repoRoot: abs, configPath: cfg };
  }
  let root = dirname(abs);
  if (root.split("/").pop() === ConfigDirName) {
    root = dirname(root);
  }
  return { repoRoot: root, configPath: abs };
}

export function fileExists(path: string): boolean {
  return existsSync(path) && !statSync(path).isDirectory();
}
