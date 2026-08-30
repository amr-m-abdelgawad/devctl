import { describe, expect, test } from "bun:test";
import { claudeSnippet, codexAddHint, codexToml, cursorSnippet, kiloSnippet, mcpUrl } from "./snippets.ts";

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
