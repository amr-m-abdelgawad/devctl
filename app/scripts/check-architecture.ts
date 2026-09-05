/**
 * Enforces hexagonal layer import rules.
 *
 * Hard rules (fail CI):
 *   domain / application / ports must not import adapters, presentation,
 *   or infrastructure SDKs (google-auth-library, @opentui/*).
 *
 * All forbidden edges fail unless the exact file pair is allowlisted.
 * Presentation only reaches application/shared/domain; adapters cannot reach legacy.
 *
 *   bun run check:architecture
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

type Layer = "domain" | "application" | "ports" | "adapters" | "presentation" | "shared" | "bootstrap" | "legacy";

const ROOT_LAYER: Record<string, Layer> = {
  "bin.ts": "bootstrap",
  "types.ts": "shared",
  "version.ts": "shared",
  "version.test.ts": "shared",
  "warnings.ts": "shared",
  "warnings.test.ts": "shared",
  "retry.ts": "shared",
  "retry.test.ts": "shared",
  "update.ts": "shared",
  "update.test.ts": "shared",
};

const ALLOWED: Record<Layer, readonly Layer[]> = {
  domain: ["domain", "shared"],
  application: ["application", "domain", "ports", "shared"],
  ports: ["ports", "domain", "shared"],
  adapters: ["adapters", "ports", "domain", "shared"],
  presentation: ["presentation", "application", "shared", "domain"],
  shared: ["shared"],
  bootstrap: ["domain", "application", "ports", "adapters", "presentation", "shared", "bootstrap", "legacy"],
  legacy: ["domain", "application", "ports", "adapters", "presentation", "shared", "bootstrap", "legacy"],
};

const FORBIDDEN_PACKAGES: Partial<Record<Layer, readonly string[]>> = {
  domain: ["google-auth-library", "@opentui/core", "@opentui/react"],
  application: ["google-auth-library", "@opentui/core", "@opentui/react"],
  ports: ["google-auth-library", "@opentui/core", "@opentui/react"],
};

// Shrink as later phases extract commands and isolate Google.
const ALLOWLIST = new Set<string>([
  // CLI composition and local file operations; migrate through ClientRuntime.
  "presentation/cli/cli.test.ts → adapters/storage/logs.ts",
  "presentation/cli/cli.test.ts → adapters/storage/storage.ts",
  "presentation/cli/cli.ts → adapters/config/index.ts",
  "presentation/cli/cli.ts → adapters/rpc/controller.ts",
  "presentation/cli/cli.ts → adapters/secrets/detector.ts",
  "presentation/cli/cli.ts → adapters/storage/logs.ts",
  "presentation/cli/cli.ts → adapters/storage/storage.ts",
  "presentation/cli/cli.ts → bootstrap/client.ts",
  "presentation/cli/cli.ts → bootstrap/daemon.ts",
  "presentation/cli/complete.ts → adapters/config/index.ts",
  "presentation/cli/setup.ts → adapters/config/index.ts",
  "presentation/cli/setup.ts → adapters/doctor/doctor.ts",
  "presentation/cli/setup.ts → adapters/google/google.ts",
  // MCP adapter-backed helpers and integration fixtures.
  "presentation/mcp/port.ts → adapters/net/ports.ts",
  "presentation/mcp/port.ts → adapters/storage/storage.ts",
  "presentation/mcp/setup.test.ts → adapters/config/index.ts",
  "presentation/mcp/setup.test.ts → bootstrap/test-supervisor.ts",
  "presentation/mcp/toolgate.test.ts → adapters/config/index.ts",
  "presentation/mcp/toolgate.test.ts → bootstrap/test-supervisor.ts",
  "presentation/mcp/tools.test.ts → adapters/secrets/detector.ts",
  "presentation/mcp/tools.test.ts → adapters/storage/logs.ts",
  "presentation/mcp/tools.ts → adapters/config/index.ts",
  "presentation/mcp/tools.ts → adapters/secrets/detector.ts",
  "presentation/mcp/tools.ts → adapters/storage/logs.ts",
  // TUI runtime operations and adapter view types; migrate through ClientRuntime.
  "presentation/tui/App.tsx → adapters/config/index.ts",
  "presentation/tui/App.tsx → adapters/google/google.ts",
  "presentation/tui/App.tsx → adapters/net/ports.ts",
  "presentation/tui/App.tsx → adapters/rpc/controller.ts",
  "presentation/tui/App.tsx → adapters/storage/logs.ts",
  "presentation/tui/App.tsx → adapters/storage/storage.ts",
  "presentation/tui/chrome.tsx → adapters/config/index.ts",
  "presentation/tui/chrome.tsx → adapters/google/google.ts",
  "presentation/tui/config-view.ts → adapters/config/index.ts",
  "presentation/tui/config-view.ts → adapters/secrets/detector.ts",
  "presentation/tui/demo-flow.test.ts → adapters/config/load.ts",
  "presentation/tui/helpers.ts → adapters/config/index.ts",
  "presentation/tui/helpers.ts → adapters/secrets/detector.ts",
  "presentation/tui/helpers.ts → adapters/storage/logs.ts",
  "presentation/tui/helpers.ts → adapters/storage/storage.ts",
  "presentation/tui/index.tsx → adapters/config/index.ts",
  "presentation/tui/index.tsx → adapters/rpc/controller.ts",
  "presentation/tui/overlays/LogDetails.tsx → adapters/storage/logs.ts",
  "presentation/tui/screens/Auth.tsx → adapters/config/index.ts",
  "presentation/tui/screens/Auth.tsx → adapters/google/google.ts",
  "presentation/tui/screens/Config.tsx → adapters/config/index.ts",
  "presentation/tui/screens/Dashboard.tsx → adapters/config/index.ts",
  "presentation/tui/screens/Dashboard.tsx → adapters/google/google.ts",
  "presentation/tui/screens/Dashboard.tsx → adapters/storage/logs.ts",
  "presentation/tui/screens/Dashboard.tsx → adapters/storage/storage.ts",
  "presentation/tui/screens/Logs.tsx → adapters/storage/logs.ts",
  "presentation/tui/screens/Profiles.tsx → adapters/config/index.ts",
  "presentation/tui/screens/Proxy.tsx → adapters/config/index.ts",
  "presentation/tui/screens/ServiceDetail.tsx → adapters/config/index.ts",
  "presentation/tui/screens/Services.tsx → adapters/config/index.ts",
  "presentation/tui/screens/Setup.tsx → adapters/config/index.ts",
  "presentation/tui/screens/Setup.tsx → adapters/google/google.ts",
  "presentation/tui/screens/Stats.tsx → adapters/config/index.ts",
  "presentation/tui/screens/Stats.tsx → adapters/storage/storage.ts",
  "presentation/tui/tui-config.ts → adapters/storage/storage.ts",
  "presentation/tui/workspace.ts → adapters/doctor/doctor.ts",
  "presentation/tui/workspace.ts → adapters/google/google.ts",

  "types.ts → adapters/storage/logs.ts",
  "types.ts → domain/service/services.ts",
  // Daemon host still composes application commands and listeners. These
  // exact edges remain until listener/dependency composition moves to bootstrap.
  "adapters/daemon/supervisor.ts → application/commands.ts",
  "adapters/daemon/supervisor.ts → application/lifecycle-session.ts",
  "adapters/daemon/supervisor.ts → application/orchestrator.ts",
  "adapters/daemon/supervisor.ts → presentation/mcp/server.ts",
  "adapters/daemon/supervisor.ts → presentation/mcp/tools.ts",
  "adapters/daemon/supervisor.ts → presentation/mcp/port.ts",
  "adapters/daemon/supervisor.ts → presentation/tui/tui-config.ts",
  // Integration tests exercise the daemon composition and its presentation contract.
  "adapters/daemon/supervisor.test.ts → presentation/mcp/tools.ts",
  "adapters/daemon/supervisor.test.ts → bootstrap/test-supervisor.ts",
  "adapters/daemon/supervisor.test.ts → presentation/tui/tui-config.ts",
  "adapters/daemon/supervisor.integration.test.ts → bootstrap/test-supervisor.ts",
  "adapters/rpc/controller.test.ts → bootstrap/test-supervisor.ts",
]);

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
