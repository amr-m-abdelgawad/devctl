import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const NPM_PACKAGE_NAME = "@amr-m-abdelgawad/devctl";
export const BUNDLED_BUN_VERSION = "1.4.0";
export const GENERATED_PACKAGE_FILES = ["LICENSE", "README.md", "bin/devctl.cjs", "dist/devctl.js", "package.json"] as const;

type PackageJson = {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
};

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function normalizeReleaseVersion(input: string): string {
  const version = input.trim().replace(/^v/, "");
  if (!SEMVER_RE.test(version)) {
    throw new Error(`invalid release version: ${input}`);
  }
  return version;
}

export function baseReleaseVersion(version: string): string {
  return normalizeReleaseVersion(version).split(/[+-]/, 1)[0] ?? "";
}

export function fallbackVersionFromSource(source: string): string {
  const match = source.match(/process\.env\.DEVCTL_VERSION\s*\?\?\s*["']([^"']+)["']/);
  if (!match?.[1]) {
    throw new Error("could not find the DEVCTL_VERSION fallback in app/src/version.ts");
  }
  return normalizeReleaseVersion(match[1]);
}

export function validateVersionAlignment(releaseVersion: string, appVersion: string, versionSource: string): string {
  const normalizedRelease = normalizeReleaseVersion(releaseVersion);
  const expectedBase = baseReleaseVersion(normalizedRelease);
  const normalizedApp = normalizeReleaseVersion(appVersion);
  const fallbackVersion = fallbackVersionFromSource(versionSource);
  if (normalizedApp !== expectedBase || fallbackVersion !== expectedBase) {
    throw new Error(
      `release ${normalizedRelease} does not match app/package.json (${normalizedApp}) and app/src/version.ts (${fallbackVersion})`,
    );
  }
  return normalizedRelease;
}

export function createPublishedPackageJson(
  template: PackageJson,
  appPackage: PackageJson,
  releaseVersion: string,
): PackageJson {
  if (template.name !== NPM_PACKAGE_NAME) {
    throw new Error(`npm package template must be named ${NPM_PACKAGE_NAME}`);
  }
  if (!appPackage.dependencies || Object.keys(appPackage.dependencies).length === 0) {
    throw new Error("app/package.json has no runtime dependencies to publish");
  }
  if (Object.hasOwn(appPackage.dependencies, "bun")) {
    throw new Error("app/package.json must not depend on Bun; the generated npm package owns that runtime dependency");
  }

  const { private: _private, dependencies: _dependencies, ...publishableTemplate } = template;
  const dependencies = Object.fromEntries(
    Object.entries({ ...appPackage.dependencies, bun: BUNDLED_BUN_VERSION }).sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    ...publishableTemplate,
    version: normalizeReleaseVersion(releaseVersion),
    dependencies,
  };
}

export function listPackageFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        files.push(relative(root, absolute).replaceAll("\\", "/"));
      }
    }
  };
  visit(root);
  return files.sort();
}

export function assertPackageFileAllowlist(root: string): void {
  const actual = listPackageFiles(root);
  const expected = [...GENERATED_PACKAGE_FILES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`generated npm package files differ from allowlist\nexpected: ${expected.join(", ")}\nactual: ${actual.join(", ")}`);
  }
}

export async function buildNpmPackage(repoRoot: string, requestedVersion: string): Promise<string> {
  const root = resolve(repoRoot);
  const appRoot = join(root, "app");
  const templateRoot = join(root, "packaging", "npm");
  const outputRoot = join(root, "dist", "npm");
  const appPackage = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as PackageJson;
  const template = JSON.parse(readFileSync(join(templateRoot, "package.template.json"), "utf8")) as PackageJson;
  const versionSource = readFileSync(join(appRoot, "src", "version.ts"), "utf8");
  const releaseVersion = validateVersionAlignment(requestedVersion, String(appPackage.version ?? ""), versionSource);

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(join(outputRoot, "bin"), { recursive: true });
  mkdirSync(join(outputRoot, "dist"), { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(appRoot, "src", "bin.ts")],
    target: "bun",
    packages: "external",
    minify: true,
    define: {
      "process.env.DEVCTL_VERSION": JSON.stringify(releaseVersion),
    },
    outdir: join(outputRoot, "dist"),
    naming: "devctl.js",
  });
  if (!result.success) {
    const messages = result.logs.map((log) => log.message).join("\n");
    throw new Error(`failed to bundle npm package${messages ? `:\n${messages}` : ""}`);
  }

  copyFileSync(join(templateRoot, "devctl.cjs"), join(outputRoot, "bin", "devctl.cjs"));
  copyFileSync(join(templateRoot, "README.md"), join(outputRoot, "README.md"));
  copyFileSync(join(root, "LICENSE"), join(outputRoot, "LICENSE"));
  const packageJson = createPublishedPackageJson(template, appPackage, releaseVersion);
  writeFileSync(join(outputRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  assertPackageFileAllowlist(outputRoot);
  return outputRoot;
}
