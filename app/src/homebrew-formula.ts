const HOMEBREW_ASSETS = ["devctl-darwin-arm64", "devctl-darwin-x64", "devctl-linux-arm64", "devctl-linux-x64"] as const;

export function parseSha256Sums(source: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match?.[1] && match[2]) {
      checksums.set(match[2].trim(), match[1].toLowerCase());
    }
  }
  return checksums;
}

export function updateHomebrewFormula(source: string, version: string, checksums: ReadonlyMap<string, string>): string {
  for (const asset of HOMEBREW_ASSETS) {
    if (!checksums.has(asset)) {
      throw new Error(`SHA256SUMS is missing ${asset}`);
    }
  }

  const lines = source.split(/\r?\n/);
  const updated: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index] ?? "";
    if (/^\s*version\s+"[^"]+"/.test(line)) {
      line = line.replace(/version\s+"[^"]+"/, `version "${version}"`);
    }
    if (/^\s*sha256\s+:no_check\s*$/.test(line)) {
      continue;
    }
    updated.push(line);

    const asset = HOMEBREW_ASSETS.find((candidate) => line.includes(`/${candidate}"`));
    if (!asset) {
      continue;
    }
    const indent = line.match(/^(\s*)/)?.[1] ?? "";
    const next = lines[index + 1] ?? "";
    if (/^\s*sha256\s+"[a-fA-F0-9]{64}"\s*$/.test(next)) {
      index += 1;
    }
    updated.push(`${indent}sha256 "${checksums.get(asset)}"`);
  }
  return `${updated.join("\n").trimEnd()}\n`;
}
