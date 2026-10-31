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
            <ClientSnippets
              snippets={connection.snippets}
              copied={copied}
              onCopy={(kind, text) => {
                void navigator.clipboard
                  .writeText(text)
                  .then(() => setCopied(kind))
                  .catch(() => setCopied("failed"));
              }}
              onHide={() => {
                setConnection(undefined);
                setCopied("");
              }}
              copyFailed={copied === "failed"}
            />
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
                  <code className="break-all text-[11px] text-muted-foreground">{tool.name}</code>
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

type Snippet = Connection["snippets"][number];

function ClientSnippets(props: {
  snippets: Snippet[];
  copied: string;
  copyFailed: boolean;
  onCopy: (kind: string, text: string) => void;
  onHide: () => void;
}) {
  const [picked, setPicked] = useState(props.snippets[0]?.kind ?? "");
  const snippet = props.snippets.find((item) => item.kind === picked) ?? props.snippets[0];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        These snippets contain your MCP bearer token. Choose a client, then paste the snippet into its configuration.
      </p>
      <div className="mcp-clients" role="list">
        {props.snippets.map((item) => {
          const selected = item.kind === snippet?.kind;
          return (
            <button
              key={item.kind}
              type="button"
              role="listitem"
              className={`mcp-client mcp-client-${item.kind}`}
              aria-pressed={selected}
              onClick={() => setPicked(item.kind)}
            >
              <ClientMark kind={item.kind} />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{item.title}</span>
                <span className="mcp-client-path" title={item.path}>{item.path}</span>
              </span>
            </button>
          );
        })}
      </div>
      {snippet ? (
        <div className="connection-snippet">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">{snippet.title}</p>
            <Button size="sm" variant="outline" onClick={() => props.onCopy(snippet.kind, snippet.text)}>
              {props.copied === snippet.kind ? "Copied" : "Copy snippet"}
            </Button>
          </div>
          <pre>{snippet.text}</pre>
        </div>
      ) : null}
      <Button size="sm" variant="ghost" onClick={props.onHide}>
        Hide connection details
      </Button>
      {props.copyFailed ? (
        <p className="text-xs text-warning">Clipboard unavailable. Select and copy the snippet above.</p>
      ) : null}
    </div>
  );
}

// Brand marks from @lobehub/icons, MIT License, Copyright (c) 2023 LobeHub.
function ClientMark(props: { kind: string }) {
  return (
    <svg className="mcp-client-mark" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
      <path fill="currentColor" d={clientPath(props.kind)} />
    </svg>
  );
}

function clientPath(kind: string): string {
  if (kind === "claude") {
    return "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z";
  }
  if (kind === "cursor") {
    return "M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z";
  }
  if (kind === "kilo") {
    return "M0 0v24h24V0H0zm22.222 22.222H1.778V1.778h20.444v20.444zm-7.555-4.964h2.222v1.778h-2.794L12.89 17.83v-2.794h1.778v2.222zm4 0h-1.778v-2.222h-2.222v-1.778h2.793l1.207 1.207v2.793zm-7.556-2.591H9.333v-1.778h1.778v1.778zm-5.778-1.778h1.778v4h4v1.778H6.54L5.333 17.46V12.89zm13.334-3.556v1.778h-5.778V9.333h1.987V7.111h-1.987V5.333h2.558l1.206 1.207v2.793h2.014zm-11.556-2h2.222l1.778 1.778v2H9.333v-2H7.111v2H5.333V5.333h1.778v2zm4 0H9.333v-2h1.778v2z";
  }
  if (kind === "codex") {
    return "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z";
  }
  return "M12 7.2a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6z";
}
