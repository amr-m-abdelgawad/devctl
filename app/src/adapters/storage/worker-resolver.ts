import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Source runs `./name.ts`. The npm bundle ships `./name.js` beside
 * dist/devctl.js, and a compiled binary embeds it at the same place beside its
 * entrypoint (see compile-binaries.sh). A worker that fails to load falls
 * back to the in-process store.
 */
export function resolveWorkerUrl(baseName: string, sourceUrl: URL, standalone = Bun.isStandaloneExecutable === true): URL {
  const javascript = new URL(`./${baseName}.js`, sourceUrl);
  // A compiled binary always carries its workers, so it does not stat Bun's
  // embedded file system, whose root is spelled differently on Windows.
  if (standalone || existsUrl(javascript)) {
    return javascript;
  }
  return sourceUrl;
}

function existsUrl(url: URL): boolean {
  if (url.protocol !== "file:") {
    return false;
  }
  try {
    return existsSync(fileURLToPath(url));
  } catch {
    return false;
  }
}
