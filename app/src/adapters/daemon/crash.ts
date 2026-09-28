import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const FLUSH_BUDGET_MS = 2_000;

export type CrashHooks = {
  logPath: string;
  flush: () => Promise<void>;
  release: () => void;
  record: (message: string) => void;
};

let installed = false;

/** Keep the process up on a stray rejection. A thrown exception flushes, drops the lock, and exits. */
export function installCrashHandlers(hooks: CrashHooks): void {
  if (installed) {
    return;
  }
  installed = true;
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    hooks.record(`unhandledRejection: ${message}`);
  });
  process.on("uncaughtException", (err) => {
    const message = err.stack ?? err.message;
    try {
      mkdirSync(dirname(hooks.logPath), { recursive: true, mode: 0o700 });
      appendFileSync(hooks.logPath, `${new Date().toISOString()} uncaughtException\n${message}\n`, { mode: 0o600 });
    } catch {
      // the bootstrap log is best-effort
    }
    void shutdown(hooks);
  });
}

async function shutdown(hooks: CrashHooks): Promise<void> {
  await Promise.race([
    hooks.flush().catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, FLUSH_BUDGET_MS);
    }),
  ]);
  try {
    hooks.release();
  } catch {
    // the lock may already be gone
  }
  process.exit(1);
}
