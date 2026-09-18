import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BUNDLED_BUN_VERSION,
  GENERATED_PACKAGE_FILES,
  assertPackageFileAllowlist,
  baseReleaseVersion,
  bundleExternalPackages,
  createPublishedPackageJson,
  fallbackVersionFromSource,
  normalizeReleaseVersion,
  publishedExternalSpecs,
  validateVersionAlignment,
} from "./npm-package.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("npm package versioning", () => {
  test("normalizes tags and accepts prerelease bootstrap versions", () => {
    expect(normalizeReleaseVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeReleaseVersion("1.2.3-bootstrap.0")).toBe("1.2.3-bootstrap.0");
    expect(baseReleaseVersion("1.2.3-bootstrap.0")).toBe("1.2.3");
    expect(() => normalizeReleaseVersion("release-1")).toThrow("invalid release version");
  });

  test("extracts and validates the source fallback", () => {
    const source = 'export const VERSION = process.env.DEVCTL_VERSION ?? "1.2.3";';
    expect(fallbackVersionFromSource(source)).toBe("1.2.3");
    expect(validateVersionAlignment("v1.2.3", "1.2.3", source)).toBe("1.2.3");
    expect(validateVersionAlignment("1.2.3-bootstrap.0", "1.2.3", source)).toBe("1.2.3-bootstrap.0");
    expect(() => validateVersionAlignment("1.2.4", "1.2.3", source)).toThrow("does not match");
  });
});

describe("published npm metadata", () => {
  test("publishes only Bun and the resolved externals, pins Bun, and removes private", () => {
    const generated = createPublishedPackageJson(
      {
        name: "@amr-m-abdelgawad/devctl",
        version: "0.0.0-development",
        private: true,
        dependencies: { shouldNotSurvive: "1.0.0" },
        license: "MIT",
      },
      {
        version: "1.2.3",
        dependencies: {
          "@opentui/core": "^0.5.11",
          yaml: "^2.9.0",
          commander: "^15.0.0",
          "google-auth-library": "^11.0.2",
          "new-lib": "^1.0.0",
        },
      },
      "1.2.3",
      { "@opentui/core": "0.5.11", "node-fetch": "^3.3.2" },
    );
    expect(generated.private).toBeUndefined();
    expect(generated.version).toBe("1.2.3");
    // The native package is pinned to the resolved version (not the declared
    // "^0.5.11"); ordinary app libraries are dropped (bundled into dist).
    expect(generated.dependencies).toEqual({ "@opentui/core": "0.5.11", bun: BUNDLED_BUN_VERSION, "node-fetch": "^3.3.2" });
    expect(generated.dependencies).not.toHaveProperty("yaml");
    expect(generated.dependencies).not.toHaveProperty("new-lib");
    expect(generated.dependencies).not.toHaveProperty("google-auth-library");
  });

  test("rejects an app package that depends on Bun, omits OpenTUI, or resolves no native version", () => {
    const template = { name: "@amr-m-abdelgawad/devctl", license: "MIT" };
    const resolved = { "@opentui/core": "0.5.11" };
    expect(() =>
      createPublishedPackageJson(template, { dependencies: { bun: "1.4.2", "@opentui/core": "^0.5.11" } }, "1.2.3", resolved),
    ).toThrow("must not depend on Bun");
    expect(() => createPublishedPackageJson(template, { dependencies: { yaml: "^2.9.0" } }, "1.2.3", resolved)).toThrow(
      "missing published runtime dependency @opentui/core",
    );
    // Declared in app/package.json but no resolved version handed in: the pure
    // function refuses rather than copying the floating spec through.
    expect(() => createPublishedPackageJson(template, { dependencies: { "@opentui/core": "^0.5.11" } }, "1.2.3", {})).toThrow(
      "missing resolved version for @opentui/core",
    );
  });
});

describe("published external pinning policy", () => {
  test("pins native packages exact and caret-ranges pure-JS runtime imports", () => {
    const installed: Record<string, string> = { "@opentui/core": "0.5.11", "node-fetch": "3.3.2" };
    const specs = publishedExternalSpecs((name) => installed[name] ?? "0.0.0");
    // Native (dlopen, ABI-coupled to the frozen bundle) is exact, like esbuild's
    // @esbuild/* and bun's @oven/*; the pure-JS runtime import is a caret range.
    expect(specs).toEqual({ "@opentui/core": "0.5.11", "node-fetch": "^3.3.2" });
  });
});

describe("bundle external packages", () => {
  test("reports real bare imports and ignores builtins, relatives, and strings", () => {
    const bundle = [
      "#!/usr/bin/env bun",
      'import x from"@opentui/core";',
      'const nf = (await import("node-fetch")).default;',
      'const lp = require("left-pad");', // dynamic require of a real package
      'const fsp = require("fs/promises");', // node builtin subpath
      'const cr = require("node:crypto");', // node: prefixed builtin
      'const w = await import("ws");', // Bun ships a built-in ws shim
      'import y from"./local.js";', // relative
      'export * from"@scope/thing/deep/path";', // scoped subpath -> @scope/thing
      'Buffer.from("data");', // method call, not an import
      'const s = "text mentioning import(\\"decoy-pkg\\")";', // string literal
      "const t = `require(\"template-decoy\")`;", // template literal
    ].join("\n");
    expect(bundleExternalPackages(bundle)).toEqual(["@opentui/core", "@scope/thing", "left-pad", "node-fetch"]);
  });
});

describe("generated package allowlist", () => {
  test("accepts exactly the publishable files and rejects extras", () => {
    const root = join(tmpdir(), `devctl-package-${crypto.randomUUID()}`);
    temporaryDirectories.push(root);
    for (const path of GENERATED_PACKAGE_FILES) {
      const absolute = join(root, path);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, "test");
    }
    expect(() => assertPackageFileAllowlist(root)).not.toThrow();
    writeFileSync(join(root, "secret.env"), "nope");
    expect(() => assertPackageFileAllowlist(root)).toThrow("differ from allowlist");
  });
});
