import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openAttach } from "./controller.ts";
import { KindGeneral } from "./errors.ts";

describe("attach", () => {
  test("openAttach does not spawn a supervisor when none is running", async () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-attach-${Date.now()}`;
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    process.env.DEVCTL_HOME = join(dir, "home");
    writeFileSync(
      join(dir, ".devctl", "config.yaml"),
      `version: 1
project:
  name: attach-test
services:
  api:
    command: [echo, ok]
`,
    );
    await expect(openAttach(dir, "")).rejects.toMatchObject({ kind: KindGeneral });
  });
});
