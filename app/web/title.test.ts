import { describe, expect, test } from "bun:test";
import { consoleDocumentTitle, repoDisplayName } from "./title.ts";

describe("web console title", () => {
  test("names the page and project", () => {
    expect(consoleDocumentTitle("Traffic", "demo-platform")).toBe("Traffic · demo-platform · devctl");
    expect(consoleDocumentTitle("Overview", "")).toBe("Overview · devctl");
    expect(consoleDocumentTitle("  ", "  ")).toBe("Console · devctl");
  });

  test("prefers project.name and falls back to the repo folder", () => {
    expect(repoDisplayName("demo-platform", "/Users/me/other")).toBe("demo-platform");
    expect(repoDisplayName("", "/Users/me/invoices/")).toBe("invoices");
    expect(repoDisplayName("  ", "C:\\work\\billing")).toBe("billing");
    expect(repoDisplayName("", "")).toBe("");
  });
});
