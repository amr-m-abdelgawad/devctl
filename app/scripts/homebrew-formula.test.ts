import { describe, expect, test } from "bun:test";
import { parseSha256Sums, updateHomebrewFormula } from "./homebrew-formula.ts";

const source = `class Devctl < Formula
  version "0.1.1"
  on_macos do
    if Hardware::CPU.arm?
      url "https://example.test/devctl-darwin-arm64"
    else
      url "https://example.test/devctl-darwin-x64"
    end
  end
  on_linux do
    if Hardware::CPU.arm?
      url "https://example.test/devctl-linux-arm64"
    else
      url "https://example.test/devctl-linux-x64"
    end
  end
  sha256 :no_check
end
`;

const sums = parseSha256Sums(
  [
    `${"a".repeat(64)}  devctl-darwin-arm64`,
    `${"b".repeat(64)}  devctl-darwin-x64`,
    `${"c".repeat(64)}  devctl-linux-arm64`,
    `${"d".repeat(64)}  devctl-linux-x64`,
  ].join("\n"),
);

describe("Homebrew release formula", () => {
  test("parses checksum manifests", () => {
    expect(sums.get("devctl-linux-x64")).toBe("d".repeat(64));
  });

  test("sets the version and a checksum beside every platform URL", () => {
    const updated = updateHomebrewFormula(source, "1.2.3", sums);
    expect(updated).toContain('version "1.2.3"');
    expect(updated).not.toContain("sha256 :no_check");
    expect(updated.match(/sha256 "/g)).toHaveLength(4);
    expect(updateHomebrewFormula(updated, "1.2.3", sums)).toBe(updated);
  });

  test("refuses an incomplete checksum manifest", () => {
    expect(() => updateHomebrewFormula(source, "1.2.3", new Map())).toThrow("SHA256SUMS is missing");
  });
});
