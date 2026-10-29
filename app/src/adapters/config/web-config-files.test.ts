import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webConfigFiles } from "./web-config-files.ts";

test("configuration writes preserve raw text and permissions and reject stale revisions", () => {
  const directory = mkdtempSync(join(tmpdir(), "devctl-editor-"));
  const path = join(directory, "config.yaml");
  try {
    const empty = webConfigFiles.read(path);
    expect(empty.exists).toBe(false);
    const original = "# Keep this comment\nversion: 1\n";
    const saved = webConfigFiles.replace(path, original, empty.revision);
    expect(saved?.text).toBe(original);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(webConfigFiles.replace(path, "overwritten", empty.revision)).toBeUndefined();
    const external = "# Edited by another editor\nversion: 1\n";
    writeFileSync(path, external);
    expect(webConfigFiles.replace(path, original, saved!.revision)).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(external);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("editing a symlink keeps the link and updates only its trusted target", () => {
  const directory = mkdtempSync(join(tmpdir(), "devctl-editor-link-"));
  const path = join(directory, "config.yaml"),
    target = join(directory, "shared.yaml");
  try {
    writeFileSync(target, "old", { mode: 0o640 });
    symlinkSync(target, path);
    const document = webConfigFiles.read(path);
    expect(webConfigFiles.replace(path, "new", document.revision)?.text).toBe("new");
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(statSync(target).mode & 0o777).toBe(0o640);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
