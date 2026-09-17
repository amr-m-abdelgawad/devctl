import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Config plugins are `import()`ed into the supervisor process and run with its
// full privileges (they can mint tokens, add proxy middleware, inject env).
// A `.devctl` from a cloned repo must not be able to point that import at code
// outside the repository, so every plugin path is resolved against the repo
// root and refused if it escapes it. This one helper is shared by the loader,
// the config validator, and the reload watcher so validation and loading never
// disagree about which paths are allowed.
export type ResolvedPluginPath = {
  fsPath: string; // absolute filesystem path
  importHref: string; // file:// URL for import()
  allowed: boolean; // true when fsPath is inside repoRoot
  reason?: string; // set when allowed is false
};

export function resolvePluginPath(rawPath: string, repoRoot: string): ResolvedPluginPath {
  let fsPath: string;
  try {
    fsPath = rawPath.startsWith("file:")
      ? fileURLToPath(rawPath)
      : isAbsolute(rawPath)
        ? rawPath
        : resolve(repoRoot, rawPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { fsPath: rawPath, importHref: rawPath, allowed: false, reason: `invalid path: ${message}` };
  }
  const root = resolve(repoRoot);
  const importHref = pathToFileURL(fsPath).href;
  if (!containedIn(root, fsPath)) {
    return { fsPath, importHref, allowed: false, reason: `plugin path must be inside the repository root (${root})` };
  }
  // Lexical containment can be defeated by an in-root symlink pointing outside
  // the repo (`plugins/x.ts -> /tmp/evil.ts`): `import()` follows the link and
  // runs the external module in-process. When the target exists, re-check
  // containment on the realpath of both sides. A path that does not exist yet
  // (e.g. at validate time) has no link to follow, so lexical containment holds.
  try {
    if (!containedIn(realpathSync(root), realpathSync(fsPath))) {
      return { fsPath, importHref, allowed: false, reason: `plugin path resolves (via a symlink) outside the repository root (${root})` };
    }
  } catch {
    // root or target missing — lexical containment above is authoritative.
  }
  return { fsPath, importHref, allowed: true };
}

// True when `candidate` is a strict descendant of `root` (never root itself).
function containedIn(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
