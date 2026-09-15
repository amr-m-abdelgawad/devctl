import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { FileSystem } from "../../ports/filesystem.ts";

export const osFileSystem: FileSystem = {
  exists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, "utf8"),
  writeText: (path, content) => writeFileSync(path, content),
  listDir: (path) => {
    try {
      return readdirSync(path, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? "dir" : "file",
      }));
    } catch {
      return [];
    }
  },
};
