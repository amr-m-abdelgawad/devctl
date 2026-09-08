import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { FileSystem } from "../../ports/filesystem.ts";

export const osFileSystem: FileSystem = {
  exists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, "utf8"),
  writeText: (path, content) => writeFileSync(path, content),
};

export class MemoryFileSystem implements FileSystem {
  constructor(private readonly files = new Map<string, string>()) {}

  exists(path: string): boolean {
    return this.files.has(path);
  }

  readText(path: string): string {
    const value = this.files.get(path);
    if (value === undefined) {
      throw new Error(`no such file: ${path}`);
    }
    return value;
  }

  writeText(path: string, content: string): void {
    this.files.set(path, content);
  }
}
