// What `devctl config validate` accepts must match what start can run.
import { afterEach, expect, test } from "bun:test";
import { bodyText, describeE2E, Sandbox, SCENARIO_TIMEOUT_MS, waitFor } from "./harness.ts";

function config(command: string[], shell = false): string {
  return `version: 1
project:
  name: e2e-command
services:
  inline:
    command: ${JSON.stringify(command)}${shell ? "\n    shell: true" : ""}
`;
}

describeE2E("command validation", () => {
  let sandbox: Sandbox | undefined;
  afterEach(async () => {
    await sandbox?.down();
    sandbox = undefined;
  });

  test("a command array with ; inside an argument validates and starts (#136)", async () => {
    sandbox = Sandbox.create("command-array", {
      ".devctl/config.yaml": config([process.execPath, "-e", "console.log('a'); console.log('b'); setInterval(() => {}, 1000)"]),
    });
    await sandbox.cli(["config", "validate"]);
    await sandbox.start(["inline"]);
    const box = sandbox;
    await waitFor("both lines from the inline script", async () => {
      const lines = (await box.logs(["inline"])).map(bodyText);
      return lines.includes("a") && lines.includes("b");
    });
  }, SCENARIO_TIMEOUT_MS);

  test("a bare pipe token is still rejected with the shell: true hint", async () => {
    sandbox = Sandbox.create("command-pipe", { ".devctl/config.yaml": config(["echo", "hi", "|", "cat"]) });
    const result = await sandbox.cli(["config", "validate"], { allowFail: true });
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("set shell: true");
  }, SCENARIO_TIMEOUT_MS);
});
