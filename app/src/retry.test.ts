import { describe, expect, test } from "bun:test";
import { KindConfiguration, KindToken, newError } from "./shared/errors.ts";
import { isRetryableError, withRetry } from "./retry.ts";

describe("withRetry", () => {
  test("retries transient failures then succeeds", async () => {
    let n = 0;
    const value = await withRetry(
      async () => {
        n += 1;
        if (n < 3) {
          throw newError(KindToken, "flaky");
        }
        return "ok";
      },
      { attempts: 3, backoffMs: 1 },
    );
    expect(value).toBe("ok");
    expect(n).toBe(3);
  });

  test("does not retry configuration errors", async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n += 1;
          throw newError(KindConfiguration, "bad yaml");
        },
        { attempts: 3, backoffMs: 1 },
      ),
    ).rejects.toThrow(/bad yaml/);
    expect(n).toBe(1);
    expect(isRetryableError(newError(KindConfiguration, "x"))).toBe(false);
  });
});
