import { buildNpmPackage } from "../src/npm-package.ts";
import { resolve } from "node:path";

const requestedVersion = process.argv[2] ?? process.env.DEVCTL_VERSION;
if (!requestedVersion) {
  console.error("usage: bun run scripts/build-npm-package.ts <version>");
  process.exit(2);
}

const repoRoot = resolve(import.meta.dir, "../..");
try {
  const outputRoot = await buildNpmPackage(repoRoot, requestedVersion);
  console.log(`npm package ready: ${outputRoot}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
