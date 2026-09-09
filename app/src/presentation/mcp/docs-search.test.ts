import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DOC_PAGES } from "./docs.generated.ts";
import { searchDocs } from "./docs-search.ts";
import { callMcpTool, MCP_TOOLS, type McpHost } from "./tools.ts";

const repoRoot = dirname(dirname(dirname(dirname(import.meta.dir))));
const docsDir = join(repoRoot, "docs");
const SKIP = new Set(["devctl-architecture.md"]);

describe("embedded docs", () => {
  test("every user-facing docs/*.md page is compiled in", () => {
    const onDisk = readdirSync(docsDir)
      .filter((name) => name.endsWith(".md") && !SKIP.has(name))
      .sort()
      .map((name) => `docs/${name}`);
    expect(DOC_PAGES.map((page) => page.path)).toEqual(onDisk);
    for (const page of DOC_PAGES) {
      const file = join(repoRoot, page.path);
      expect(page.body).toBe(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
    }
  });
});

describe("searchDocs", () => {
  test("ranks IAP OAuth client docs above unrelated pages", () => {
    const result = searchDocs("iap client_id oauth");
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.path).toBe("docs/iap.md");
    expect(result.hits[0]?.snippet.toLowerCase()).toContain("client_id");
  });

  test("includes the onboarding skill when it matches", () => {
    const result = searchDocs("authoring yaml unknown fields");
    expect(result.hits.some((hit) => hit.path.includes("devctl-onboard"))).toBe(true);
  });

  test("rejects an empty query", () => {
    expect(() => searchDocs("")).toThrow(/query is required/);
    expect(() => searchDocs("   ")).toThrow(/query is required/);
  });
});

describe("search_docs tool", () => {
  test("is advertised and returns hits through callMcpTool", async () => {
    expect(MCP_TOOLS.some((tool) => tool.name === "search_docs")).toBe(true);
    const unused = (): never => {
      throw new Error("search_docs must not touch the supervisor");
    };
    const host: McpHost = {
      config: unused,
      validateConfigText: unused,
      status: unused,
      logsPage: unused,
      start: unused,
      stop: unused,
      restart: unused,
      reload: unused,
      doctor: unused,
      runTask: unused,
      startProxy: unused,
      stopProxy: unused,
    };
    const result = (await callMcpTool(host, "search_docs", { query: "proxy listen port", limit: 3 })) as {
      query: string;
      hits: Array<{ path: string; snippet: string }>;
    };
    expect(result.query).toBe("proxy listen port");
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.length).toBeLessThanOrEqual(3);
    expect(result.hits.some((hit) => hit.path === "docs/proxy.md" || hit.path === "docs/configuration.md")).toBe(true);
  });
});
