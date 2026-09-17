#!/usr/bin/env node
"use strict";

const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const version = process.argv[2];
const changelogPath = process.argv[3] || "CHANGELOG.md";
if (!version) {
  console.error("usage: node compose-github-release-notes.cjs <version> [CHANGELOG.md]");
  process.exit(2);
}

const repo = process.env.GITHUB_REPOSITORY || "amr-m-abdelgawad/devctl";
const tag = `v${version}`;
const source = readFileSync(resolve(changelogPath), "utf8")
  .replace(/^\uFEFF/, "")
  .replace(/\r\n/g, "\n");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractRelease(markdown, releaseVersion) {
  const heading = new RegExp(
    `^## \\[${escapeRegExp(releaseVersion)}\\](?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`,
    "m",
  );
  const match = heading.exec(markdown);
  if (!match) {
    throw new Error(`CHANGELOG.md has no ## [${releaseVersion}] section`);
  }
  const rest = markdown.slice(match.index + match[0].length);
  const next = /^## \[/m.exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest).trim();
  const nextHeading = next ? /^## \[([^\]]+)\]/m.exec(rest.slice(next.index)) : null;
  const previous =
    nextHeading && nextHeading[1].toLowerCase() !== "unreleased" ? nextHeading[1] : undefined;
  return { body, previous };
}

function splitLead(body) {
  const lines = body.split("\n");
  const leadLines = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("#") || line.startsWith("- ")) break;
    leadLines.push(line);
    index += 1;
  }
  return {
    leadText: leadLines.join("\n").trim(),
    sections: lines.slice(index).join("\n").trim().replace(/^### /gm, "## "),
  };
}

function rewriteDocsLinks(text) {
  return text.replace(/\]\((docs\/[^)]+)\)/g, (_match, path) => `](https://github.com/${repo}/blob/${tag}/${path})`);
}

const { body, previous } = extractRelease(source, version);
const { leadText, sections } = splitLead(body);
const parts = [];

if (leadText) {
  const paragraphs = leadText.split(/\n\n+/);
  const headline = paragraphs[0].replace(/^\*\*|\*\*$/g, "");
  parts.push(`**${headline}**`);
  if (paragraphs.length > 1) parts.push(paragraphs.slice(1).join("\n\n"));
}
if (sections) parts.push(sections);

parts.push(`## Upgrading

\`\`\`bash
npm install --global @amr-m-abdelgawad/devctl
\`\`\`

\`\`\`bash
npx @amr-m-abdelgawad/devctl@latest
\`\`\`

\`\`\`bash
brew upgrade devctl
\`\`\`

Run \`devctl down\` then start again so the attached daemon is ${version}. Restarting the TUI alone is not enough if the old supervisor is still running.

Trust notice: the standalone macOS, Linux, and Windows binaries are unsigned. Verify SHA256SUMS and the GitHub build-provenance attestations. The npm package is published separately with npm provenance.`);

if (previous) {
  parts.push(`**Full Changelog**: https://github.com/${repo}/compare/v${previous}...${tag}`);
}

process.stdout.write(`${rewriteDocsLinks(parts.join("\n\n"))}\n`);
