// Doc drift: every complete config example in docs/*.md passes
// `devctl config validate`. A complete example has top-level `version:`
// and `services:`; shorter snippets are fragments of a larger file.
import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeE2E, E2E_DIR, Sandbox, SCENARIO_TIMEOUT_MS } from "./harness.ts";

const DOCS_DIR = join(E2E_DIR, "..", "..", "docs");
// Files an example references but the reader creates, e.g. a plugin module.
const MISSING_FILE = /does not exist: (\S+)/g;

type Example = { file: string; line: number; yaml: string };

function completeExamples(): Example[] {
  const examples: Example[] = [];
  for (const file of readdirSync(DOCS_DIR).filter((name) => name.endsWith(".md")).sort()) {
    const text = readFileSync(join(DOCS_DIR, file), "utf8");
    for (const match of text.matchAll(/```ya?ml\n([\s\S]*?)```/g)) {
      const yaml = match[1] ?? "";
      if (/^version:/m.test(yaml) && /^services:/m.test(yaml)) {
        examples.push({ file: `docs/${file}`, line: text.slice(0, match.index).split("\n").length, yaml });
      }
    }
  }
  return examples;
}

describeE2E("docs config examples", () => {
  let sandbox: Sandbox | undefined;
  afterEach(async () => {
    await sandbox?.down();
    sandbox = undefined;
  });

  test("the docs still contain complete examples to check", () => {
    expect(completeExamples().length).toBeGreaterThan(0);
  });

  for (const example of completeExamples()) {
    test(`${example.file}:${example.line} passes config validate`, async () => {
      sandbox = Sandbox.create("docs-example", { ".devctl/config.yaml": example.yaml });
      let result = await sandbox.cli(["config", "validate"], { allowFail: true });
      const missing = [...(result.stdout + result.stderr).matchAll(MISSING_FILE)].map((m) => m[1] ?? "");
      if (result.code !== 0 && missing.length > 0) {
        for (const path of missing) {
          sandbox.write(path, "");
        }
        result = await sandbox.cli(["config", "validate"], { allowFail: true });
      }
      expect(result.stdout + result.stderr).toContain("configuration is valid");
    }, SCENARIO_TIMEOUT_MS);
  }
});
