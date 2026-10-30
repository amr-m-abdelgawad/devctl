import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, basename, resolve } from "node:path";
import type { ConfigDocument, WebConfigFiles } from "../../ports/web-host.ts";

function targetPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function read(path: string): ConfigDocument {
  const target = targetPath(path);
  const exists = existsSync(target);
  const text = exists ? readFileSync(target, "utf8") : "";
  const revision = createHash("sha256")
    .update(target)
    .update("\0")
    .update(exists ? "1" : "0")
    .update(text)
    .digest("hex");
  return { path, text, revision, exists };
}

export const webConfigFiles: WebConfigFiles = {
  read,
  replace(path, text, revision) {
    if (read(path).revision !== revision) return undefined;
    const target = targetPath(path);
    mkdirSync(dirname(target), { recursive: true });
    const temporary = join(dirname(target), `.${basename(target)}.devctl-${randomUUID()}`);
    const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
    if (existsSync(target)) accessSync(target, constants.W_OK);
    try {
      writeFileSync(temporary, text, { encoding: "utf8", mode, flag: "wx" });
      chmodSync(temporary, mode);
      // Validation may take time; recheck immediately before the atomic replacement.
      if (read(path).revision !== revision) return undefined;
      renameSync(temporary, target);
      return read(path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  },
};
