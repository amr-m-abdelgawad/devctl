import { describe, expect, test } from "bun:test";
import { claudeSnippet, codexAddHint, codexToml, cursorSnippet, isWritableSnippet, kiloSnippet, mcpUrl, mergeSnippetFile, snippetPath } from "./snippets.ts";

const URL = "http://127.0.0.1:18721/mcp";
const TOKEN = "abc123";

describe("mcp snippets", () => {
  test("claude JSON requires type http", () => {
    const parsed = JSON.parse(claudeSnippet(URL, TOKEN)) as {
      mcpServers: { devctl: { type: string; url: string; headers: { Authorization: string } } };
    };
    expect(parsed.mcpServers.devctl.type).toBe("http");
    expect(parsed.mcpServers.devctl.url).toBe(URL);
    expect(parsed.mcpServers.devctl.headers.Authorization).toBe("Bearer abc123");
  });

  test("cursor JSON is url plus headers without type", () => {
    const parsed = JSON.parse(cursorSnippet(URL, TOKEN)) as {
      mcpServers: { devctl: { type?: string; url: string } };
    };
    expect(parsed.mcpServers.devctl.type).toBeUndefined();
    expect(parsed.mcpServers.devctl.url).toBe(URL);
  });

  test("kilo uses mcp root and type remote", () => {
    const parsed = JSON.parse(kiloSnippet(URL, TOKEN)) as {
      mcp: { devctl: { type: string; url: string; enabled: boolean } };
    };
    expect(parsed.mcp.devctl.type).toBe("remote");
    expect(parsed.mcp.devctl.enabled).toBe(true);
    expect(parsed.mcp.devctl.url).toBe(URL);
  });

  test("codex copies TOML not JSON", () => {
    const text = codexToml(URL, TOKEN);
    expect(text).toContain("[mcp_servers.devctl]");
    expect(text).toContain(`url = "${URL}"`);
    expect(text).toContain('http_headers = { Authorization = "Bearer abc123" }');
    expect(codexAddHint(URL)).toBe(`codex mcp add --url ${URL}`);
    expect(mcpUrl(18721)).toBe(URL);
  });
});

describe("mergeSnippetFile (devctl mcp --write)", () => {
  const url = "http://127.0.0.1:18801/mcp";

  test("a new file holds just devctl's entry", () => {
    expect(JSON.parse(mergeSnippetFile("claude", undefined, url, "tok"))).toEqual({
      mcpServers: { devctl: { type: "http", url, headers: { Authorization: "Bearer tok" } } },
    });
  });

  test("other servers and keys are kept; devctl's entry is replaced", () => {
    const existing = JSON.stringify({ mcpServers: { other: { url: "x" }, devctl: { url: "old" } }, extra: 1 });
    expect(JSON.parse(mergeSnippetFile("cursor", existing, url, "tok"))).toEqual({
      mcpServers: { other: { url: "x" }, devctl: { url, headers: { Authorization: "Bearer tok" } } },
      extra: 1,
    });
  });

  test("a file that isn't plain JSON is left for a hand edit", () => {
    expect(() => mergeSnippetFile("kilo", "// comment\n{}", url, "tok")).toThrow("kilo.jsonc is not plain JSON");
    expect(() => mergeSnippetFile("claude", "[]", url, "tok")).toThrow(".mcp.json is not a JSON object");
  });

  test("only project-level clients are writable", () => {
    expect(isWritableSnippet("claude")).toBe(true);
    expect(isWritableSnippet("codex")).toBe(false);
    expect(snippetPath("cursor")).toBe(".cursor/mcp.json");
  });
});
