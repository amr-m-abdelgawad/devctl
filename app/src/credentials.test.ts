import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, test } from "bun:test";
import { credentialFilePath, openCredentialStore } from "./credentials.ts";

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
});
