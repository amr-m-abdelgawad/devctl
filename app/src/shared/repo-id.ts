import { createHash } from "node:crypto";
import { resolve } from "node:path";
const REPO_ID_LENGTH = 16;

export function repoID(repoRoot: string): string {
  // Every caller that names the same repository must land in the same state
  // directory, even when one spelling contains redundant separators or is
  // relative. Otherwise the daemon can bind one socket while its client dials
  // another (macOS TMPDIR commonly ends in a separator, which exposed this).
  const canonical = resolve(repoRoot);
  const normalized = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const sum = createHash("sha256").update(normalized).digest("hex");
  return sum.slice(0, REPO_ID_LENGTH);
}

