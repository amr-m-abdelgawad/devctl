import { createHash } from "node:crypto";
import { resolve } from "node:path";
const REPO_ID_LENGTH = 16;

/** Names accepted by `--instance` (and DEVCTL_INSTANCE). */
export const INSTANCE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * The id every per-stack path and name is derived from: state directory,
 * socket, lock, tokens, container and volume names, the MCP port. A checkout
 * is one stack; `--instance <name>` adds more stacks in the same checkout,
 * each with an id of its own. The default instance ("") keeps the id a
 * checkout always had.
 */
export function repoID(repoRoot: string, instance = ""): string {
  // Every caller that names the same repository must land in the same state
  // directory, even when one spelling contains redundant separators or is
  // relative. Otherwise the daemon can bind one socket while its client dials
  // another (macOS TMPDIR commonly ends in a separator, which exposed this).
  const canonical = resolve(repoRoot);
  const normalized = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  // A NUL can't appear in a path, so no checkout's id collides with another
  // checkout's named instance.
  const key = instance === "" ? normalized : `${normalized}\0${instance}`;
  const sum = createHash("sha256").update(key).digest("hex");
  return sum.slice(0, REPO_ID_LENGTH);
}
