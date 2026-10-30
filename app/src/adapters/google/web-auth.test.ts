import { expect, test } from "bun:test";
import { GoogleWebAuth } from "./web-auth.ts";

function child() {
  let out!: ReadableStreamDefaultController<Uint8Array>, err!: ReadableStreamDefaultController<Uint8Array>;
  const exited = Promise.withResolvers<number>();
  const writes: string[] = [];
  let kills = 0;
  const process = {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        out = controller;
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        err = controller;
      },
    }),
    stdin: { write: (value: string) => writes.push(value), flush() {} },
    exited: exited.promise,
    kill: () => {
      kills += 1;
      out.close();
      err.close();
      exited.resolve(130);
    },
  };
  return {
    process,
    writes,
    get kills() {
      return kills;
    },
    output: (value: string) => err.enqueue(new TextEncoder().encode(value)),
    finish: (code: number) => {
      out.close();
      err.close();
      exited.resolve(code);
    },
  };
}

test("web sign-in relays a complete Google URL and one code without exposing process output", async () => {
  const proc = child();
  let changed = 0;
  const auth = new GoogleWebAuth(
    async () => {
      changed++;
    },
    { spawn: () => proc.process },
  );
  const session = auth.start();
  expect(auth.start().id).toBe(session.id);
  proc.output("Open:\nhttps://accounts.google.com/o/oauth2/auth?state=abc");
  await Bun.sleep(1);
  expect(auth.status()?.phase).toBe("starting");
  proc.output("&code_challenge=example\nEnter authorization code: ");
  await Bun.sleep(1);
  expect(auth.status()).toMatchObject({
    phase: "awaiting_code",
    url: "https://accounts.google.com/o/oauth2/auth?state=abc&code_challenge=example",
  });
  expect(() => auth.submit("stale-id", "code")).toThrow();
  expect(() => auth.submit(session.id, "one\ntwo")).toThrow();
  expect(auth.submit(session.id, "private-one-time-code").phase).toBe("finishing");
  expect(proc.writes).toEqual(["private-one-time-code\n"]);
  proc.output("private process output and private-one-time-code\n");
  proc.finish(0);
  await Bun.sleep(1);
  expect(auth.status()).toEqual({ id: session.id, phase: "succeeded" });
  expect(changed).toBe(1);
  expect(JSON.stringify(auth.status())).not.toContain("private");
  auth.dispose();
});

test("cancellation kills the login process and ignores its late completion", async () => {
  const proc = child();
  let changed = 0;
  const auth = new GoogleWebAuth(
    async () => {
      changed++;
    },
    { spawn: () => proc.process },
  );
  const session = auth.start();
  auth.cancel(session.id);
  await Bun.sleep(1);
  expect(proc.kills).toBe(1);
  expect(auth.status()?.phase).toBe("cancelled");
  expect(changed).toBe(0);
});

test("expired login sessions terminate and failed sign-outs do not claim success", async () => {
  const proc = child();
  const auth = new GoogleWebAuth(async () => {}, {
    spawn: () => proc.process,
    timeoutMs: 5,
    revoke: async () => {
      throw new Error("revoke failed");
    },
  });
  auth.start();
  await Bun.sleep(15);
  expect(proc.kills).toBe(1);
  expect(auth.status()?.phase).toBe("failed");
  await expect(auth.logout()).rejects.toThrow("revoke failed");
});

test("spawn and exit failures expose safe actionable errors without process output", async () => {
  const unavailable = new GoogleWebAuth(async () => {}, {
    spawn: () => {
      throw new Error("sensitive local path");
    },
  });
  expect(unavailable.start()).toMatchObject({ phase: "failed" });
  expect(unavailable.status()?.error).toContain("Install the Google Cloud CLI");
  expect(JSON.stringify(unavailable.status())).not.toContain("sensitive");
  const proc = child();
  const auth = new GoogleWebAuth(async () => {}, { spawn: () => proc.process });
  auth.start();
  proc.output("secret diagnostic output\nhttps://accounts.google.com.evil.example/login\n");
  await Bun.sleep(1);
  expect(auth.status()?.phase).toBe("starting");
  proc.finish(2);
  await Bun.sleep(1);
  expect(auth.status()).toMatchObject({ phase: "failed", error: "Google sign-in failed (exit 2). Start again to retry." });
});

test("sign-out cancels pending login, revokes once and refreshes identity; probe failures remain failures", async () => {
  const proc = child();
  let revoked = 0,
    refreshed = 0;
  const auth = new GoogleWebAuth(
    async () => {
      refreshed++;
    },
    {
      spawn: () => proc.process,
      revoke: async () => {
        revoked++;
      },
    },
  );
  auth.start();
  expect(() => auth.cancel("stale-id")).toThrow("changed");
  await auth.logout();
  expect(proc.kills).toBe(1);
  expect(revoked).toBe(1);
  expect(refreshed).toBe(1);
  const failedProbe = child();
  const failing = new GoogleWebAuth(
    async () => {
      throw new Error("private probe output");
    },
    { spawn: () => failedProbe.process },
  );
  failing.start();
  failedProbe.finish(0);
  await Bun.sleep(1);
  expect(failing.status()).toMatchObject({ phase: "failed" });
  expect(JSON.stringify(failing.status())).not.toContain("private");
});
