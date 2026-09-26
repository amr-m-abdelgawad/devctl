// `devctl config import compose` on real compose files.
import { afterEach, expect, test } from "bun:test";
import { describeE2E, Sandbox, SCENARIO_TIMEOUT_MS } from "./harness.ts";

async function importAndValidate(box: Sandbox): Promise<void> {
  const imported = await box.cli(["config", "import", "compose", "compose.yaml", "--write"]);
  expect(imported.stdout).toContain("wrote ");
  const validated = await box.cli(["config", "validate"]);
  expect(validated.stdout).toContain("configuration is valid");
}

describeE2E("compose import", () => {
  let sandbox: Sandbox | undefined;
  afterEach(async () => {
    await sandbox?.down();
    sandbox = undefined;
  });

  test("an image service without published ports imports and validates", async () => {
    sandbox = Sandbox.create("compose-plain", {
      "compose.yaml": `services:
  cache:
    image: redis:7-alpine
  worker:
    image: alpine:3.20
    command: ["sleep", "300"]
    environment:
      QUEUE: jobs
    depends_on:
      - cache
`,
    });
    await importAndValidate(sandbox);
  }, SCENARIO_TIMEOUT_MS);

  // Known failure: published ports import as an invalid `ports` list (#135).
  test.failing("a service that publishes a port imports and validates (#135)", async () => {
    sandbox = Sandbox.create("compose-ports", {
      "compose.yaml": `services:
  cache:
    image: redis:7-alpine
    ports:
      - "6379:6379"
`,
    });
    await importAndValidate(sandbox);
  }, SCENARIO_TIMEOUT_MS);

  // Starting imported container services needs Docker on the runner and the
  // container parity work in #120; add the start step with it.
  test.todo("imported container services start (#120)", () => undefined);
});
