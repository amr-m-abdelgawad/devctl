import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { hintError, KindConfigurationMissing, wrapError } from "../errors.ts";

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
    KindConfigurationMissing,
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
    throw wrapError(KindConfigurationMissing, "config path not found", err);
  }
  if (info.isDirectory()) {
    // Whether abs is named .devctl decides repoRoot on its own — it must
    // not depend on config.yaml already existing inside it. That existence
    // check used to run first and win whenever the file was already there
    // (the ordinary case), so this branch was effectively unreachable and
    // an explicit --config pointing at .devctl resolved repoRoot to .devctl
    // itself instead of its parent, contradicting the documented contract
    // ("repository root is the directory that contains .devctl").
    if (basename(abs) === ConfigDirName) {
      return { repoRoot: dirname(abs), configPath: join(abs, ConfigFileName) };
    }
    return { repoRoot: abs, configPath: join(abs, ConfigFileName) };
  }
  let root = dirname(abs);
  if (basename(root) === ConfigDirName) {
    root = dirname(root);
  }
  return { repoRoot: root, configPath: abs };
}

export function fileExists(path: string): boolean {
  return existsSync(path) && !statSync(path).isDirectory();
}
