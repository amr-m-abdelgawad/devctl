#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: node verify-npm-pack.cjs <npm-pack-dry-run.json>");
  process.exit(2);
}

const expected = ["LICENSE", "README.md", "bin/devctl.cjs", "dist/devctl.js", "package.json"];
const report = JSON.parse(readFileSync(reportPath, "utf8"));
assert.equal(report.length, 1, "npm pack must produce exactly one package report");
const actual = report[0].files.map((file) => file.path).sort();
assert.deepEqual(actual, expected, `npm tarball allowlist mismatch:\n${actual.join("\n")}`);
console.log(`npm tarball contains only the ${expected.length} allowed files`);
