import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { FileSystem } from "../../ports/filesystem.ts";

export const osFileSystem: FileSystem = {
  exists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, "utf8"),
  writeText: (path, content) => writeFileSync(path, content),
};
