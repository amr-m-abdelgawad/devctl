import { spawn } from "bun";
import { KindProcessStart, wrapError } from "../../shared/errors.ts";

/**
 * Runs a command in the foreground (`devctl test -- <command>`): stdio is
 * the caller's, so output streams live, and SIGINT/SIGTERM sent to devctl
 * reach the command too. Resolves with its exit code; a signal-killed
 * command resolves 128 + the signal number, as a shell reports it.
 */
export async function runForeground(command: readonly string[], env: Record<string, string>, cwd: string): Promise<number> {
  let proc;
  try {
    proc = spawn({ cmd: [...command], env, cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  } catch (err) {
    throw wrapError(KindProcessStart, `unable to run ${command[0] ?? ""}`, err);
  }
  const code = await proc.exited;
  if (proc.signalCode) {
    return 128 + (SIGNALS[proc.signalCode] ?? 1);
  }
  return code ?? 1;
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
