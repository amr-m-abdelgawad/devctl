export type McpSnippetKind = "claude" | "cursor" | "kilo" | "codex";

export type McpSnippet = {
  readonly kind: McpSnippetKind;
  readonly title: string;
  readonly path: string;
  readonly language: "json" | "toml";
  readonly text: string;
  readonly hint?: string;
};

export function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

export function authHeaders(token: string): Record<string, string> {
  if (token === "") {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}

export function claudeSnippet(url: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        devctl: {
          type: "http",
          url,
          headers: authHeaders(token),
        },
      },
    },
    null,
    2,
  );
}

export function cursorSnippet(url: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        devctl: {
          url,
          headers: authHeaders(token),
        },
      },
    },
    null,
    2,
  );
}

export function kiloSnippet(url: string, token: string): string {
  return JSON.stringify(
    {
      mcp: {
        devctl: {
          type: "remote",
          url,
          headers: authHeaders(token),
          enabled: true,
        },
      },
    },
    null,
    2,
  );
}

export function codexToml(url: string, token: string): string {
  const header = token === "" ? "" : `\nhttp_headers = { Authorization = "Bearer ${token}" }`;
  return `[mcp_servers.devctl]\nurl = "${url}"${header}\n`;
}

export function codexAddHint(url: string): string {
  return `codex mcp add --url ${url}`;
}

export function mcpSnippets(url: string, token: string): McpSnippet[] {
  return [
    {
      kind: "claude",
      title: "Claude",
      path: ".mcp.json",
      language: "json",
      text: claudeSnippet(url, token),
      hint: "claude mcp add-json",
    },
    {
      kind: "cursor",
      title: "Cursor",
      path: ".cursor/mcp.json",
      language: "json",
      text: cursorSnippet(url, token),
    },
    {
      kind: "kilo",
      title: "Kilo Code",
      path: "kilo.jsonc",
      language: "json",
      text: kiloSnippet(url, token),
    },
    {
      kind: "codex",
      title: "Codex",
      path: "~/.codex/config.toml",
      language: "toml",
      text: codexToml(url, token),
      hint: codexAddHint(url),
    },
  ];
}

export function formatMcpSnippets(url: string, token: string): string {
  const lines = [`URL  ${url}`, ""];
  for (const snippet of mcpSnippets(url, token)) {
    lines.push(`# ${snippet.title}  ${snippet.path}${snippet.hint ? `  (${snippet.hint})` : ""}`);
    lines.push(snippet.text.trimEnd());
    lines.push("");
  }
  return lines.join("\n");
}

/** Clients whose MCP config lives in the project, so each worktree can point its agent at its own stack. */
export const WRITABLE_SNIPPETS = ["claude", "cursor", "kilo"] as const;
export type WritableSnippetKind = (typeof WRITABLE_SNIPPETS)[number];

export function isWritableSnippet(kind: string): kind is WritableSnippetKind {
  return (WRITABLE_SNIPPETS as readonly string[]).includes(kind);
}

/**
 * The client's project config with devctl's server entry set to this stack's
 * URL and token. Every other key and server in `existing` is kept, so
 * writing again after a token rotation only replaces devctl's entry.
 */
export function mergeSnippetFile(kind: WritableSnippetKind, existing: string | undefined, url: string, token: string): string {
  const snippet = mcpSnippets(url, token).find((entry) => entry.kind === kind);
  if (!snippet) {
    throw new Error(`no ${kind} snippet`);
  }
  const fresh = JSON.parse(snippet.text) as Record<string, Record<string, unknown>>;
  if (existing === undefined || existing.trim() === "") {
    return `${JSON.stringify(fresh, null, 2)}\n`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    throw new Error(`${snippet.path} is not plain JSON (comments or a syntax error); add devctl's entry by hand from \`devctl mcp\``);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${snippet.path} is not a JSON object`);
  }
  const doc = parsed as Record<string, unknown>;
  for (const [section, servers] of Object.entries(fresh)) {
    const current = doc[section];
    const kept = typeof current === "object" && current !== null && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
    doc[section] = { ...kept, ...servers };
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function snippetPath(kind: WritableSnippetKind): string {
  return mcpSnippets("", "").find((entry) => entry.kind === kind)?.path ?? "";
}
