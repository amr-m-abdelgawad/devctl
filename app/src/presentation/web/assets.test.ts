import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashWebSources } from "../../../scripts/build-web-assets.ts";
import { WEB_INDEX_HTML, WEB_SOURCES_HASH } from "./assets.generated.ts";

const appRoot = dirname(dirname(dirname(import.meta.dir)));
const webRoot = join(appRoot, "web");

describe("embedded web assets", () => {
  test("source hash matches WEB_SOURCES_HASH", () => {
    expect(WEB_SOURCES_HASH).toBe(hashWebSources(webRoot));
  });

  // Same reason as guide.test.ts: a Windows checkout with core.autocrlf=true
  // has CRLF on disk while the Linux-built WEB_SOURCES_HASH is LF. Hash the
  // logical source, not the checkout's line endings.
  test("source hash is stable across CRLF checkouts", () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-web-hash-"));
    try {
      writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
      const lf = hashWebSources(dir);
      writeFileSync(join(dir, "a.ts"), "export const x = 1;\r\n");
      expect(hashWebSources(dir)).toBe(lf);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the blob is a self-contained HTML document", () => {
    expect(WEB_INDEX_HTML.startsWith("<!doctype html>") || WEB_INDEX_HTML.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(WEB_INDEX_HTML).not.toMatch(/<(?:script|link|img|iframe)[^>]+\s(?:src|href)=["']https?:/i);
    expect(WEB_INDEX_HTML).not.toMatch(/<(?:script|link|img|iframe)[^>]+\s(?:src|href)=["']\/\//i);
    expect(WEB_INDEX_HTML).not.toMatch(/fetch\s*\(\s*["']https?:/i);
    expect(WEB_INDEX_HTML).not.toMatch(/fetch\s*\(\s*["']\/\//i);
    const urls = WEB_INDEX_HTML.match(/https?:\/\/[^\s"'`<>\\]+/g) ?? [];
    expect(urls.every((url) => url.startsWith("http://www.w3.org/"))).toBe(true);
    expect(WEB_INDEX_HTML.toLowerCase().split("</script").length).toBe(2);
  });
});
