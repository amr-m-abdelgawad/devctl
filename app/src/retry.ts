import { DevctlError, KindAuthorization, KindConfiguration } from "./shared/errors.ts";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 200;

export type RetryOptions = {
  attempts?: number;
  backoffMs?: number;
  retry?: (err: unknown) => boolean;
};

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const retry = opts.retry ?? isRetryableError;
  let lastErr: unknown = new Error("retry exhausted");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!retry(err) || attempt === attempts - 1) {
        throw err;
      }
      await sleep(backoffMs * (attempt + 1));
    }
  }
  throw lastErr;
}

export function isRetryableError(err: unknown): boolean {
  if (err instanceof DevctlError) {
    return err.kind !== KindConfiguration && err.kind !== KindAuthorization;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
