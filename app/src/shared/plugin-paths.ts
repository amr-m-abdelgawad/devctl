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
  const rel = relative(root, fsPath);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  const importHref = pathToFileURL(fsPath).href;
  if (!inside) {
    return { fsPath, importHref, allowed: false, reason: `plugin path must be inside the repository root (${root})` };
  }
  return { fsPath, importHref, allowed: true };
}
