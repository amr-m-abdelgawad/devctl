import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { hashWebSources } from "../../../scripts/build-web-assets.ts";
import { WEB_INDEX_HTML, WEB_SOURCES_HASH } from "./assets.generated.ts";

const appRoot = dirname(dirname(dirname(import.meta.dir)));
const webRoot = join(appRoot, "web");

describe("embedded web assets", () => {
  test("source hash matches WEB_SOURCES_HASH", () => {
    expect(WEB_SOURCES_HASH).toBe(hashWebSources(webRoot));
  });

  test("the blob is a self-contained HTML document", () => {
    expect(WEB_INDEX_HTML.startsWith("<!doctype html>") || WEB_INDEX_HTML.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(WEB_INDEX_HTML).not.toMatch(/<(?:script|link|img|iframe)[^>]+\s(?:src|href)=["']https?:/i);
    expect(WEB_INDEX_HTML).not.toMatch(/<(?:script|link|img|iframe)[^>]+\s(?:src|href)=["']\/\//i);
    expect(WEB_INDEX_HTML).not.toMatch(/fetch\s*\(\s*["']https?:/i);
    expect(WEB_INDEX_HTML).not.toMatch(/fetch\s*\(\s*["']\/\//i);
    expect(WEB_INDEX_HTML).not.toMatch(/https?:\/\//);
    expect(WEB_INDEX_HTML.toLowerCase().split("</script").length).toBe(2);
  });
});
