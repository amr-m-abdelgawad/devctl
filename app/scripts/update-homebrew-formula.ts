import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeReleaseVersion } from "../src/npm-package.ts";
import { parseSha256Sums, updateHomebrewFormula } from "../src/homebrew-formula.ts";

const requestedVersion = process.argv[2];
const checksumArgument = process.argv[3];
if (!requestedVersion || !checksumArgument) {
  console.error("usage: bun run scripts/update-homebrew-formula.ts <version> <SHA256SUMS>");
  process.exit(2);
}

const repoRoot = resolve(import.meta.dir, "../..");
const formulaPath = resolve(repoRoot, "homebrew", "devctl.rb");
const checksumPath = resolve(process.cwd(), checksumArgument);
try {
  const version = normalizeReleaseVersion(requestedVersion);
  const formula = readFileSync(formulaPath, "utf8");
  const checksums = parseSha256Sums(readFileSync(checksumPath, "utf8"));
  writeFileSync(formulaPath, updateHomebrewFormula(formula, version, checksums), "utf8");
  console.log(`updated ${formulaPath} for ${version}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
