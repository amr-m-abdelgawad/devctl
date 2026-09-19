import { existsSync, readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { clampMcpPort } from "../../domain/net/mcp-port.ts";
import type { LocalWebPatch } from "../../domain/ui/preferences.ts";
import { KindConfiguration, newError } from "../../shared/errors.ts";
import { writeFileSecure } from "../storage/storage.ts";
import { repoLocalConfigPath } from "./tui-preferences.ts";

export { repoLocalConfigPath };

export function hasLocalConfigPatch(patch: LocalWebPatch): boolean {
  return patch.web_enabled !== undefined || patch.web_port !== undefined || patch.inspect_max_bytes !== undefined;
}

export function patchRepoLocalConfig(repoRoot: string, patch: LocalWebPatch): string {
  if (!hasLocalConfigPatch(patch)) {
    return repoLocalConfigPath(repoRoot);
  }
  const path = repoLocalConfigPath(repoRoot);
  const doc = existsSync(path) ? parseDocument(readFileSync(path, "utf8")) : parseDocument("");
  if (patch.web_enabled !== undefined) {
    doc.setIn(["web", "enabled"], patch.web_enabled);
  }
  if (patch.web_port !== undefined) {
    const port = clampMcpPort(patch.web_port);
    if (port !== patch.web_port) {
      throw newError(KindConfiguration, `web.listen.port ${patch.web_port} is invalid`);
    }
    doc.setIn(["web", "listen", "port"], port);
  }
  if (patch.inspect_max_bytes !== undefined) {
    if (patch.inspect_max_bytes < 0) {
      throw newError(KindConfiguration, `inspect_max_bytes ${patch.inspect_max_bytes} must be >= 0`);
    }
    doc.setIn(["proxy", "inspect_max_bytes"], patch.inspect_max_bytes);
    doc.setIn(["llm", "capture_max_bytes"], patch.inspect_max_bytes);
  }
  const text = String(doc).trimEnd();
  writeFileSecure(path, `${text}\n`);
  return path;
}
