import { useEffect, useState } from "react";
import { fetchMcpTools } from "../api.ts";
import { useOperatorAction } from "../operator.ts";
import type { McpToolRow, StatusSummary } from "../types.ts";
import type { RunControl } from "../control.ts";
import { ConfirmAction } from "./confirm-action.tsx";
import { SearchInput, FilterSelect } from "./filters.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";

type Connection = { url: string; snippets: Array<{ kind: string; title: string; language: string; path: string; text: string }> };

export function McpControls(props: { status?: StatusSummary; busy: boolean; onControl: RunControl }) {
  const [tools, setTools] = useState<McpToolRow[]>([]);
  const [draft, setDraft] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [connection, setConnection] = useState<Connection>();
  const [loadError, setLoadError] = useState("");
  const [copied, setCopied] = useState("");
  const { run, error, pending } = useOperatorAction();
  const load = async () => {
    try {
      const next = await fetchMcpTools();
      setTools(next);
      setDraft(next.filter((tool) => !tool.enabled).map((tool) => tool.name));
      setLoadError("");
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : "Unable to load MCP tools");
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const changes = tools.filter((tool) => tool.enabled === draft.includes(tool.name));
  const visible = tools.filter(
    (tool) =>
      (!category || tool.category === category) &&
      `${tool.name} ${tool.label} ${tool.summary}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Coding-agent connection</CardTitle>
          <Badge variant={props.status?.mcp.running ? "success" : "muted"}>{props.status?.mcp.running ? "Running" : "Stopped"}</Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="break-all font-mono text-xs">{props.status?.mcp.address || "Start MCP to connect your coding tools."}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={props.busy}
              onClick={() =>
                props.onControl("set_preferences", { scope: "repo", mcp_enabled: !props.status?.mcp.running }, "Updating MCP listener…")
              }
            >
              {props.status?.mcp.running ? "Stop MCP" : "Start MCP"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(pending) || !props.status?.mcp.running}
              onClick={() => {
                void run<Connection>("mcp_connection").then(setConnection);
              }}
            >
              Show client setup
            </Button>
            <ConfirmAction
              label="Rotate token"
              title="Rotate the MCP bearer token?"
              description="Connected coding tools must update their saved connection details afterward."
              disabled={Boolean(pending)}
              onConfirm={async () => {
                await run("mcp_rotate", { confirm: true });
                setConnection(undefined);
              }}
            />
          </div>
          {connection ? (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">
                These snippets contain your MCP bearer token. Paste one into the indicated client configuration.
              </p>
              {connection.snippets.map((snippet) => (
                <details key={snippet.kind} className="connection-snippet">
                  <summary>
                    {snippet.title}
                    <span className="ml-2 font-mono text-[10px] text-muted-foreground">{snippet.path}</span>
                  </summary>
                  <pre>{snippet.text}</pre>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(snippet.text)
                        .then(() => setCopied(snippet.kind))
                        .catch(() => setCopied("failed"));
                    }}
                  >
                    {copied === snippet.kind ? "Copied" : "Copy snippet"}
                  </Button>
                </details>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setConnection(undefined)}>
                Hide connection details
              </Button>
              {copied === "failed" ? (
                <p className="text-xs text-warning">Clipboard unavailable. Select and copy the snippet above.</p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Agent tools</CardTitle>
          <Badge variant="muted">{tools.length - draft.length} enabled</Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <SearchInput
              label="Find an MCP tool"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              className="flex-1"
            />
            <FilterSelect
              label="Tool category"
              value={category}
              onChange={setCategory}
              options={[
                { value: "", label: "All categories" },
                ...[...new Set(tools.map((tool) => tool.category))].map((value) => ({ value, label: value })),
              ]}
            />
          </div>
          {loadError || error ? (
            <p role="alert" className="text-xs text-destructive">
              {loadError || error}
            </p>
          ) : null}
          {changes.length ? (
            <div className="selection-bar">
              <span className="flex-1 text-xs">{changes.length} tool permission changes</span>
              <ConfirmAction
                label="Apply changes"
                title="Apply agent tool permissions?"
                description={
                  <ul className="flex flex-col gap-1">
                    {changes.map((tool) => (
                      <li key={tool.name}>
                        {draft.includes(tool.name) ? "Disable" : "Enable"}: {tool.label}
                      </li>
                    ))}
                  </ul>
                }
                disabled={Boolean(pending)}
                onConfirm={async () => {
                  const next = await run<McpToolRow[]>("mcp_tools", { disabled: draft, confirm: true });
                  if (next) {
                    setTools(next);
                    setDraft(next.filter((tool) => !tool.enabled).map((tool) => tool.name));
                  }
                }}
              />
              <Button size="sm" variant="ghost" onClick={() => setDraft(tools.filter((tool) => !tool.enabled).map((tool) => tool.name))}>
                Discard
              </Button>
            </div>
          ) : null}
          <div className="mcp-tools">
            {visible.map((tool) => (
              <label key={tool.name}>
                <input
                  type="checkbox"
                  checked={!draft.includes(tool.name)}
                  disabled={Boolean(pending)}
                  onChange={() =>
                    setDraft((current) =>
                      current.includes(tool.name) ? current.filter((name) => name !== tool.name) : [...current, tool.name],
                    )
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{tool.label}</p>
                  <p className="break-words text-xs text-muted-foreground">{tool.summary}</p>
                  <code className="break-all text-[10px] text-muted-foreground">{tool.name}</code>
                </div>
                <Badge variant={tool.mutates ? "warning" : "muted"}>{tool.mutates ? "Changes state" : "Read"}</Badge>
              </label>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
