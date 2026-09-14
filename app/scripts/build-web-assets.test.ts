import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inlineAssets } from "./build-web-assets.ts";

describe("inlineAssets", () => {
  test("inlines an empty script tag including a spaced end tag", () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-inline-"));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "app.js"), "console.log(1);");
      const html = `<!doctype html><script src="app.js"></script ><p>ok</p>`;
      expect(inlineAssets(html, dir)).toBe("<!doctype html><script>console.log(1);</script><p>ok</p>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("escapes a closing script sequence inside the bundle", () => {
    const dir = mkdtempSync(join(tmpdir(), "devctl-inline-"));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "app.js"), `const s = "</script>";`);
      const html = `<script src="app.js"></script>`;
      expect(inlineAssets(html, dir)).toBe(`<script>const s = "<\\/script>";</script>`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
