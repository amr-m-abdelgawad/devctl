/**
 * Enforces hexagonal layer import rules.
 *
 * Hard rules (fail CI):
 *   domain / application / ports must not import adapters, presentation,
 *   or infrastructure SDKs (google-auth-library, @opentui/*).
 *
 * All forbidden edges fail unless the exact file pair is allowlisted.
 * Presentation may import presentation, application, ports, shared, and domain.
 * Adapters cannot reach presentation, application, or legacy. `*.test.ts` is
 * layer `test` and may import any layer. The production allowlist is empty.
 *
 *   bun run check:architecture
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

type Layer = "domain" | "application" | "ports" | "adapters" | "presentation" | "shared" | "bootstrap" | "legacy" | "test";

const ROOT_LAYER: Record<string, Layer> = {
  "bin.ts": "bootstrap",
  "types.ts": "shared",
  "version.ts": "shared",
};

const ALL_LAYERS: readonly Layer[] = ["domain", "application", "ports", "adapters", "presentation", "shared", "bootstrap", "legacy", "test"];

const ALLOWED: Record<Layer, readonly Layer[]> = {
  domain: ["domain", "shared"],
  application: ["application", "domain", "ports", "shared"],
  ports: ["ports", "domain", "shared"],
  adapters: ["adapters", "ports", "domain", "shared"],
  presentation: ["presentation", "application", "ports", "shared", "domain"],
  shared: ["shared"],
  bootstrap: ["domain", "application", "ports", "adapters", "presentation", "shared", "bootstrap", "legacy"],
  legacy: ["domain", "application", "ports", "adapters", "presentation", "shared", "bootstrap", "legacy"],
  test: ALL_LAYERS,
};

const FORBIDDEN_PACKAGES: Partial<Record<Layer, readonly string[]>> = {
  domain: ["google-auth-library", "@opentui/core", "@opentui/react"],
  application: ["google-auth-library", "@opentui/core", "@opentui/react"],
  ports: ["google-auth-library", "@opentui/core", "@opentui/react"],
};

const ALLOWLIST = new Set<string>([]);

function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else if (rel.endsWith(".ts") || rel.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

function layerOf(rel: string): Layer {
  if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) {
    return "test";
  }
  const top = rel.split("/")[0] ?? rel;
  if (top === "domain" || top === "application" || top === "ports" || top === "adapters" || top === "presentation" || top === "shared" || top === "bootstrap") {
    return top;
  }
  return ROOT_LAYER[rel] ?? "legacy";
}

function normalizeRel(fromDir: string, spec: string): string {
  const parts = (fromDir ? fromDir.split("/") : []).concat(spec.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

type ArchitectureSource = { path: string; source: string };

function importSpecifiers(file: ArchitectureSource): string[] {
  const tree = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const add = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) imports.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return imports;
}

export function checkArchitecture(files: readonly ArchitectureSource[], allowlist: ReadonlySet<string> = ALLOWLIST): string[] {
  const violations: string[] = [];
  const unusedAllow = new Set(allowlist);

  for (const file of files) {
    const rel = file.path;
    const fromLayer = layerOf(rel);
    for (const spec of importSpecifiers(file)) {
      if (!spec || spec.startsWith("node:") || spec.startsWith("bun:")) continue;
      if (spec.startsWith(".")) {
        const fromDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
        const resolved = normalizeRel(fromDir, spec);
        const toLayer = layerOf(resolved);
        if (ALLOWED[fromLayer].includes(toLayer)) continue;
        const key = `${rel} → ${resolved}`;
        if (allowlist.has(key)) {
          unusedAllow.delete(key);
          continue;
        }
        violations.push(`${rel} (${fromLayer}) imports ${resolved} (${toLayer})`);
        continue;
      }
      const forbidden = FORBIDDEN_PACKAGES[fromLayer];
      if (!forbidden) continue;
      if (forbidden.some((pkg) => spec === pkg || spec.startsWith(`${pkg}/`))) {
        const key = `${rel} → ${spec}`;
        if (allowlist.has(key)) {
          unusedAllow.delete(key);
          continue;
        }
        violations.push(`${rel} (${fromLayer}) imports package ${spec}`);
      }
    }
  }

  if (unusedAllow.size > 0) {
    for (const key of [...unusedAllow].sort()) {
      violations.push(`unused allowlist entry: ${key}`);
    }
  }

  return violations;
}

if (import.meta.main) {
  const srcRoot = join(import.meta.dir, "..", "src");
  const files = walk(srcRoot).map((path) => ({ path, source: readFileSync(join(srcRoot, path), "utf8") }));
  const violations = checkArchitecture(files);
  if (violations.length > 0) {
    process.stderr.write(`architecture violations (${violations.length}):\n`);
    for (const violation of violations) process.stderr.write(`  ${violation}\n`);
    process.exit(1);
  }
  process.stdout.write(`architecture ok (${files.length} files)\n`);
}
