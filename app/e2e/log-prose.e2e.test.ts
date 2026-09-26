// #113: a plain-text line that ends with a JSON object keeps its prose.
import { afterEach, expect, test } from "bun:test";
import { bodyText, describeE2E, Sandbox, SCENARIO_TIMEOUT_MS, waitFor } from "./harness.ts";

const LINE = 'upload failed: 400, reason: {"error": "quota exceeded"}';
const SERVICE = `console.error(${JSON.stringify(LINE)}); setInterval(() => {}, 1000)`;

describeE2E("log parsing (#113)", () => {
  let sandbox: Sandbox | undefined;
  afterEach(async () => {
    await sandbox?.down();
    sandbox = undefined;
  });

  test("prose followed by JSON stays the body; the object becomes attributes", async () => {
    sandbox = Sandbox.create("log-prose", {
      "liner.js": SERVICE,
      ".devctl/config.yaml": `version: 1
project:
  name: e2e-log-prose
services:
  liner:
    command: [${JSON.stringify(process.execPath)}, liner.js]
`,
    });
    await sandbox.start(["liner"]);
    const box = sandbox;
    const record = await waitFor("the liner's stderr line", async () =>
      (await box.logs(["liner"])).find((rec) => rec.source === "stderr"));
    expect(bodyText(record)).toBe(LINE);
    expect(record.attributes.error).toBe("quota exceeded");
    expect(record.severityText).toBe("ERROR");
  }, SCENARIO_TIMEOUT_MS);
});
