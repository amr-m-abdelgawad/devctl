import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BUNDLED_BUN_VERSION,
  GENERATED_PACKAGE_FILES,
  assertPackageFileAllowlist,
  baseReleaseVersion,
  createPublishedPackageJson,
  fallbackVersionFromSource,
  normalizeReleaseVersion,
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
  test("copies runtime dependencies, pins Bun, and removes private", () => {
    const generated = createPublishedPackageJson(
      {
        name: "@amr-m-abdelgawad/devctl",
        version: "0.0.0-development",
        private: true,
        dependencies: { shouldNotSurvive: "1.0.0" },
        license: "MIT",
      },
      { version: "1.2.3", dependencies: { yaml: "^2.9.0", commander: "^15.0.0" } },
      "1.2.3",
    );
    expect(generated.private).toBeUndefined();
    expect(generated.version).toBe("1.2.3");
    expect(generated.dependencies).toEqual({ bun: BUNDLED_BUN_VERSION, commander: "^15.0.0", yaml: "^2.9.0" });
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
