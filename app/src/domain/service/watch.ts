import { DEFAULT_WATCH_IGNORE, type ServiceWatchConfig } from "../config/types.ts";

/** Policy only: adapters watch the filesystem; this decides whether a changed path should restart. */
export function shouldRestartOnWatch(watch: ServiceWatchConfig | undefined, relativePath: string): boolean {
  if (!watch?.enabled) {
    return false;
  }
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === "" || normalized.includes("..")) {
    return false;
  }
  const ignore = watch.ignore.length > 0 ? watch.ignore : DEFAULT_WATCH_IGNORE;
  if (ignore.some((pattern) => globMatch(pattern, normalized))) {
    return false;
  }
  if (watch.paths.length === 0) {
    return false;
  }
  return watch.paths.some((root) => {
    const prefix = root.replaceAll("\\", "/").replace(/\/$/, "");
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

export function globMatch(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**/", "<<<DS>>>").replaceAll("**", "<<<DS>>>").replaceAll("*", "[^/]*").replaceAll("<<<DS>>>", ".*");
  return new RegExp(`^${escaped}$`).test(path);
}
