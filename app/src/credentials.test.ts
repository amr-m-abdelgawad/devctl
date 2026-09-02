import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { credentialFilePath, openCredentialStore } from "./credentials.ts";
import { credentialsDir } from "./storage.ts";

function home(): void {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-creds-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  process.env.DEVCTL_HOME = dir;
}

describe("CredentialStore", () => {
  test("file backend stores and lists without throwing", async () => {
    home();
    const store = openCredentialStore("file");
    expect(store.backend).toBe("file");
    await store.set("user|aud", {
      identity: "user",
      audience: "aud",
      scopes: [],
      accessToken: "secret-value",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await store.get("user|aud")).toBeUndefined();
    const listed = await store.list();
    expect(listed[0]?.identity).toBe("user");
    expect(listed[0]?.valid).toBe(true);
    const raw = await Bun.file(credentialFilePath("user|aud")).text();
    expect(raw).not.toContain("secret-value");
    expect(basename(credentialFilePath("user|aud"))).not.toContain("|");
    await store.delete("user|aud");
    expect(await store.get("user|aud")).toBeUndefined();
  });

  // Regression: the filename is safeKey(key) — a lossy sanitization that
  // replaces ":" "@" "|" "/" with "_" — so list() used to reconstruct a key
  // from the filename that didn't match the real key anymore. A caller
  // merging this list with another source keyed by the real key (as
  // KeychainCredentialStore does, unioning file-derived and
  // keychain-remembered rows into one map) never saw the two as the same
  // credential, so the same identity+audience showed up twice. list() must
  // report the original key, not a filename reconstruction of it.
  test("list() reports the real key, not a lossy reconstruction from the sanitized filename", async () => {
    home();
    const store = openCredentialStore("file");
    const key = "sa:test-389@example.com|https://invoices-worker.local|";
    await store.set(key, {
      identity: "sa:test-389@example.com",
      audience: "https://invoices-worker.local",
      scopes: [],
      accessToken: "secret-value",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.key).toBe(key);
    // Sanity check this actually exercises the lossy path: the filename on
    // disk is not the raw key.
    expect(basename(credentialFilePath(key))).not.toContain(key);
  });

  test("list() still works for a file written before the key field existed", async () => {
    home();
    const key = "sa:legacy@example.com|aud|";
    writeFileSync(
      credentialFilePath(key),
      `${JSON.stringify({
        identity: "sa:legacy@example.com",
        audience: "aud",
        scopes: [],
        accessToken: "",
        tokenType: "Bearer",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })}\n`,
    );
    const store = openCredentialStore("file");
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.identity).toBe("sa:legacy@example.com");
    // No stored key to recover — falls back to the filename-derived guess
    // rather than dropping the entry.
    expect(listed[0]?.key).toBe(basename(credentialFilePath(key)).replace(/\.cred\.json$/, ""));
  });

  // Regression: rememberKey() (called from every KeychainCredentialStore.set())
  // has no symmetric counterpart on delete, so a deleted credential's key
  // stayed in keychain-index.json forever — list()'s second loop then keeps
  // trying (and failing) to fetch a key nothing backs, on every future call.
  // Seed the index directly rather than going through set(), so this test
  // never touches the real OS keychain (delete() on a key with no real
  // keychain item is a harmless no-op there; only the index file matters).
  test("delete() forgets the key so it stops haunting future list() calls", async () => {
    home();
    const indexPath = join(credentialsDir(), "keychain-index.json");
    const key = "sa:ghost@example.com|aud|";
    writeFileSync(indexPath, `${JSON.stringify([key, "user||"])}\n`);
    const store = openCredentialStore("keychain");
    await store.delete(key);
    const remaining = JSON.parse(readFileSync(indexPath, "utf8")) as string[];
    expect(remaining).toEqual(["user||"]);
  });
});
