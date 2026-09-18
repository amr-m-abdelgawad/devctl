import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative, resolve } from "node:path";

export const NPM_PACKAGE_NAME = "@amr-m-abdelgawad/devctl";
export const BUNDLED_BUN_VERSION = "1.4.2";
export const GENERATED_PACKAGE_FILES = ["LICENSE", "README.md", "bin/devctl.cjs", "dist/devctl.js", "package.json"] as const;
// Native packages that must exist on disk (dlopen). Kept external from the bundle
// and published pinned to the exact version installed at build time: the frozen
// bundle is only ever validated against that build, so a floating range could
// pair it with an untested (and possibly ABI-incompatible) install. Presence in
// app/package.json stays the source of truth for *whether* one ships. Every other
// app dependency is inlined into dist/devctl.js.
export const PUBLISHED_APP_DEPENDENCIES = ["@opentui/core"] as const;
// Pure-JS packages the bundler emits as runtime imports instead of inlining:
// gaxios reaches Google's token endpoints through `await import("node-fetch")` on
// every non-browser runtime. They are not app dependencies, so their versions are
// resolved from the installed tree and published as caret ranges — semver keeps
// them compatible and lets security patches reach consumers without a republish,
// matching how native CLIs (esbuild, sharp, @swc/core) range their JS deps while
// pinning their native platform packages exact.
export const PUBLISHED_RUNTIME_EXTERNALS = ["node-fetch"] as const;

const NODE_BUILTINS = new Set(builtinModules);

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
  resolvedExternals: Record<string, string> = {},
): PackageJson {
  if (template.name !== NPM_PACKAGE_NAME) {
    throw new Error(`npm package template must be named ${NPM_PACKAGE_NAME}`);
  }
  if (Object.hasOwn(appPackage.dependencies ?? {}, "bun")) {
    throw new Error("app/package.json must not depend on Bun; the generated npm package owns that runtime dependency");
  }

  const { private: _private, dependencies: _dependencies, ...publishableTemplate } = template;
  const published: Record<string, string> = { bun: BUNDLED_BUN_VERSION };
  // app/package.json declaring a native package is the source of truth for
  // *whether* it ships; every published version comes from resolvedExternals
  // (native exact, runtime caret) that buildNpmPackage resolves from the tree —
  // never a floating spec copied out of app/package.json.
  for (const name of PUBLISHED_APP_DEPENDENCIES) {
    if (!appPackage.dependencies?.[name]) {
      throw new Error(`app/package.json is missing published runtime dependency ${name}`);
    }
    if (!resolvedExternals[name]) {
      throw new Error(`missing resolved version for ${name}; buildNpmPackage must resolve every published external`);
    }
  }
  for (const [name, spec] of Object.entries(resolvedExternals)) {
    published[name] = spec;
  }
  return {
    ...publishableTemplate,
    version: normalizeReleaseVersion(releaseVersion),
    dependencies: Object.fromEntries(Object.entries(published).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function isBuiltinSpecifier(specifier: string): boolean {
  return specifier === "bun" || specifier.startsWith("node:") || specifier.startsWith("bun:") || NODE_BUILTINS.has(specifier);
}

function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? specifier);
}

// Bare packages the emitted bundle still imports at runtime. Bun leaves anything
// in `external` — and every dynamic `import()` of a bare specifier — out of
// dist/devctl.js, so those modules must be reachable on disk. Uses Bun's import
// scanner (parses syntax, so specifiers inside strings/templates and `.from(`
// method calls are ignored) and reduces each import/require to its package name,
// dropping relative paths and Node/Bun builtins.
export function bundleExternalPackages(bundle: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: "js" });
  const source = bundle.startsWith("#!") ? bundle.slice(bundle.indexOf("\n") + 1) : bundle;
  const packages = new Set<string>();
  for (const record of transpiler.scanImports(source)) {
    const specifier = record.path;
    if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || isBuiltinSpecifier(specifier)) {
      continue;
    }
    packages.add(packageNameOf(specifier));
  }
  return [...packages].sort();
}

// Apply the ecosystem pinning convention to the published externals: native
// packages exact (the frozen bundle is validated against this build and their
// ABI is version-coupled — as esbuild/sharp/@swc/core pin their platform
// packages), pure-JS runtime imports as caret ranges (semver keeps them
// compatible and lets security patches flow without a devctl republish).
export function publishedExternalSpecs(resolveVersion: (name: string) => string): Record<string, string> {
  const specs: Record<string, string> = {};
  for (const name of PUBLISHED_APP_DEPENDENCIES) {
    specs[name] = resolveVersion(name);
  }
  for (const name of PUBLISHED_RUNTIME_EXTERNALS) {
    specs[name] = `^${resolveVersion(name)}`;
  }
  return specs;
}

function resolveInstalledVersion(appRoot: string, name: string): string {
  // Resolve through the module graph rather than assuming a flat, hoisted
  // node_modules/<name> path, so symlinked / non-flat layouts report the same
  // copy the bundle's runtime imports resolve.
  let manifestPath: string;
  try {
    manifestPath = Bun.resolveSync(`${name}/package.json`, appRoot);
  } catch {
    throw new Error(`cannot resolve installed ${name}; run \`bun install\` in app/ before building the npm package`);
  }
  const version = (JSON.parse(readFileSync(manifestPath, "utf8")) as PackageJson).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`installed ${name} has no version at ${manifestPath}`);
  }
  return version;
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
    minify: true,
    // Keep the native packages external. Bun's `external` matches a package by
    // name, so subpath exports like `@opentui/core/yoga` stay external too and
    // their native/worker assets are never pulled into the bundle.
    external: [...PUBLISHED_APP_DEPENDENCIES],
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

  const bundlePath = join(outputRoot, "dist", "devctl.js");
  const bundle = readFileSync(bundlePath, "utf8");

  // Everything the bundle still imports at runtime must be reachable on disk.
  // Fail loudly if a new dependency shows up as an external the install graph
  // does not cover, rather than shipping a package that crashes on first use.
  const allowed = new Set<string>([...PUBLISHED_APP_DEPENDENCIES, ...PUBLISHED_RUNTIME_EXTERNALS]);
  const referenced = bundleExternalPackages(bundle);
  const undeclared = referenced.filter((name) => !allowed.has(name));
  if (undeclared.length > 0) {
    throw new Error(
      `npm bundle references undeclared external packages: ${undeclared.join(", ")}. ` +
        "Inline them, or declare native packages in PUBLISHED_APP_DEPENDENCIES and runtime imports in PUBLISHED_RUNTIME_EXTERNALS (app/scripts/npm-package.ts).",
    );
  }
  const stale = PUBLISHED_RUNTIME_EXTERNALS.filter((name) => !referenced.includes(name));
  if (stale.length > 0) {
    throw new Error(`PUBLISHED_RUNTIME_EXTERNALS lists packages the bundle no longer imports: ${stale.join(", ")}`);
  }
  const unusedNative = PUBLISHED_APP_DEPENDENCIES.filter((name) => !referenced.includes(name));
  if (unusedNative.length > 0) {
    throw new Error(`PUBLISHED_APP_DEPENDENCIES lists packages the bundle no longer imports: ${unusedNative.join(", ")}`);
  }
  // Native packages pinned exact, pure-JS runtime imports caret-ranged — both
  // derived from the versions on disk the bundle was built and validated against.
  const resolvedExternals = publishedExternalSpecs((name) => resolveInstalledVersion(appRoot, name));

  copyFileSync(join(templateRoot, "devctl.cjs"), join(outputRoot, "bin", "devctl.cjs"));
  copyFileSync(join(templateRoot, "README.md"), join(outputRoot, "README.md"));
  copyFileSync(join(root, "LICENSE"), join(outputRoot, "LICENSE"));
  const packageJson = createPublishedPackageJson(template, appPackage, releaseVersion, resolvedExternals);
  writeFileSync(join(outputRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  assertPackageFileAllowlist(outputRoot);
  return outputRoot;
}
