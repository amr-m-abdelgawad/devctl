import { existsSync, readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { clampMcpPort } from "../../domain/net/mcp-port.ts";
import type { LocalWebPatch } from "../../domain/ui/preferences.ts";
import { KindConfiguration, newError } from "../../shared/errors.ts";
import { writeFileSecure } from "../storage/storage.ts";
import { repoLocalConfigPath } from "./tui-preferences.ts";

export { repoLocalConfigPath };

export function patchRepoLocalConfig(repoRoot: string, patch: LocalWebPatch): string {
  if (patch.web_enabled === undefined && patch.web_port === undefined) {
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
  const text = String(doc).trimEnd();
  writeFileSecure(path, `${text}\n`);
  return path;
}
