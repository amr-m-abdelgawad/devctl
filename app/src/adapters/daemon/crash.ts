import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FLUSH_BUDGET_MS = 2_000;

export type CrashHooks = {
  logPath: string;
  flush: () => Promise<void>;
  release: () => void;
  record: (message: string) => void;
};

let installed = false;
let hooks: CrashHooks | undefined;

/** Keep the process up on a stray rejection. A thrown exception flushes, drops the lock, and exits. */
export function installCrashHandlers(initial: CrashHooks): void {
  hooks = initial;
  if (installed) {
    return;
  }
  installed = true;
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    hooks?.record(`unhandledRejection: ${message}`);
  });
  process.on("uncaughtException", (err) => {
    const current = hooks;
    if (!current) {
      process.exit(1);
    }
    const message = err.stack ?? err.message;
    try {
      current.record(`uncaughtException: ${message}`);
    } catch {
      // the log store may already be broken
    }
    try {
      mkdirSync(dirname(current.logPath), { recursive: true, mode: 0o700 });
      appendFileSync(current.logPath, `${new Date().toISOString()} uncaughtException\n${message}\n`, { mode: 0o600 });
      writeFileSync(join(dirname(current.logPath), "exit"), `${JSON.stringify({ at: new Date().toISOString(), reason: "uncaughtException" })}\n`, { mode: 0o600 });
    } catch {
      // the bootstrap log is best-effort
    }
    void shutdown(current);
  });
}

/** Rebind flush and record once the supervisor and log store exist. */
export function updateCrashHooks(next: Partial<CrashHooks>): void {
  if (hooks) {
    hooks = { ...hooks, ...next };
  }
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
