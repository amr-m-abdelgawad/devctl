import { basename, dirname } from "node:path";
import { KindGeneral, newError } from "../../shared/errors.ts";

/** Packs `dir` into a gzipped tarball at `file` with the system `tar` (Linux, macOS, Windows 10+). */
export function archiveDirectory(dir: string, file: string): void {
  let result;
  try {
    result = Bun.spawnSync({ cmd: ["tar", "-czf", file, "-C", dirname(dir), basename(dir)], stdout: "ignore", stderr: "pipe" });
  } catch (err) {
    throw newError(KindGeneral, `could not write ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (result.exitCode !== 0) {
    throw newError(KindGeneral, `could not write ${file}: ${result.stderr.toString().trim()}`);
  }
}
