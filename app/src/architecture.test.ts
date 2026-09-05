import { describe, expect, test } from "bun:test";
import { checkArchitecture } from "../scripts/check-architecture.ts";

const noExceptions = new Set<string>();

function audit(path: string, source: string): string[] {
  return checkArchitecture([{ path, source }], noExceptions);
}

describe("architecture boundaries", () => {
  test.each([
    'import { load } from "../../adapters/config/index.ts";',
    'export { load } from "../../adapters/config/index.ts";',
    'import type { Config } from "../../adapters/config/index.ts";',
    'type Config = import("../../adapters/config/index.ts").Config;',
    'const load = () => import("../../adapters/config/index.ts");',
    'const load = () => import(`../../adapters/config/index.ts`);',
    'const config = require("../../adapters/config/index.ts");',
    'import config = require("../../adapters/config/index.ts");',
  ])("rejects presentation-to-adapter imports: %s", (source) => {
    expect(audit("presentation/cli/example.ts", source)).toEqual([
      "presentation/cli/example.ts (presentation) imports adapters/config/index.ts (adapters)",
    ]);
  });

  test("presentation cannot reach bootstrap or legacy modules", () => {
    expect(audit("presentation/tui/example.tsx", `
      import { createClient } from "../../bootstrap/client.ts";
      import { old } from "../../old.ts";
    `)).toHaveLength(2);
  });

  test("adapters cannot reach legacy modules", () => {
    expect(audit("adapters/doctor/example.ts", 'import { old } from "../../old.ts";')).toEqual([
      "adapters/doctor/example.ts (adapters) imports old.ts (legacy)",
    ]);
  });

  test("application cannot import the doctor adapter", () => {
    expect(audit("application/commands.ts", 'import { runDoctor } from "../adapters/doctor/doctor.ts";')).toHaveLength(1);
  });

  test("only the exact allowlisted source and target pair is exempt", () => {
    const source = 'import { load } from "../../adapters/config/index.ts";';
    expect(checkArchitecture([
      { path: "presentation/cli/allowed.ts", source },
      { path: "presentation/cli/new.ts", source },
    ], new Set(["presentation/cli/allowed.ts → adapters/config/index.ts"]))).toEqual([
      "presentation/cli/new.ts (presentation) imports adapters/config/index.ts (adapters)",
    ]);
  });

  test("removed dependencies leave failing stale exceptions", () => {
    expect(checkArchitecture([{ path: "presentation/cli/allowed.ts", source: "export {};" }],
      new Set(["presentation/cli/allowed.ts → adapters/config/index.ts"]))).toEqual([
      "unused allowlist entry: presentation/cli/allowed.ts → adapters/config/index.ts",
    ]);
  });

  test("comments and quoted examples are not imports", () => {
    expect(audit("presentation/cli/example.ts", `
      // import { load } from "../../adapters/config/index.ts";
      /* export { load } from "../../adapters/config/index.ts"; */
      const help = 'import { load } from "../../adapters/config/index.ts";';
    `)).toEqual([]);
  });

  test("inward imports remain allowed", () => {
    expect(audit("presentation/tui/example.tsx", `
      import { RunDoctor } from "../../application/commands.ts";
      import type { Report } from "../../domain/doctor/types.ts";
      import { humanMessage } from "../../shared/errors.ts";
    `)).toEqual([]);
    expect(audit("application/commands.ts", 'import type { DoctorRunner } from "../ports/doctor-runner.ts";')).toEqual([]);
  });

  test("domain still rejects infrastructure SDKs", () => {
    expect(audit("domain/example.ts", 'import { GoogleAuth } from "google-auth-library";')).toEqual([
      "domain/example.ts (domain) imports package google-auth-library",
    ]);
  });
});
