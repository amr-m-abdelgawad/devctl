import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Source `./name.ts`, published `./name.js`, or a sibling of a compiled binary. */
export function resolveWorkerUrl(baseName: string, sourceUrl: URL): URL {
  const javascript = new URL(`./${baseName}.js`, sourceUrl);
  if (existsUrl(javascript)) {
    return javascript;
  }
  if (existsUrl(sourceUrl)) {
    return sourceUrl;
  }
  if (Bun.isStandaloneExecutable === true) {
    const ext = process.platform === "win32" ? ".exe" : "";
    const sibling = join(dirname(process.execPath), `${baseName}${ext}`);
    if (existsSync(sibling)) {
      return pathToFileURL(sibling);
    }
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
