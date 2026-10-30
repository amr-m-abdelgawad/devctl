import { ConfigEditor } from "../components/config-editor.tsx";
import { useCallback, useEffect, useState } from "react";
import { fetchConfigSources } from "../api.ts";
import { hrefFor } from "../hash.ts";
import { ArrowClockwiseIcon } from "../icons.ts";
import { ChoiceGroup, FilterSelect, SearchInput } from "../components/filters.tsx";
import { JsonViewer } from "../components/json-viewer.tsx";
import { Empty } from "../components/primitives.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import type { ConfigSources, ConfigSummary } from "../types.ts";
import type { RunControl } from "../control.ts";

export function ConfigPage(props: { config?: ConfigSummary; active: boolean; busy: boolean; onControl: RunControl }) {
  const [tab, setTab] = useState("services");
  const [search, setSearch] = useState("");
  const [layer, setLayer] = useState("");
  const [sources, setSources] = useState<ConfigSources>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSources(await fetchConfigSources());
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unable to load configuration sources");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (props.active) void load();
  }, [load, props.active, props.config?.config_path, props.busy]);
  useEffect(() => {
    const refresh = (): void => {
      if (props.active) void load();
    };
    window.addEventListener("devctl:refresh", refresh);
    return () => window.removeEventListener("devctl:refresh", refresh);
  }, [load, props.active]);
  const entries = (sources?.entries ?? []).filter(
    (entry) =>
      (!layer || entry.layer === layer) && `${entry.path} ${entry.source} ${entry.value}`.toLowerCase().includes(search.toLowerCase()),
  );
  const services = (props.config?.services ?? []).filter((row) =>
    `${row.name} ${row.description}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="flex flex-col gap-5">
      <div className="workspace-actionbar">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{props.config?.project || "Workspace configuration"}</p>
          <p className="break-all font-mono text-[11px] text-muted-foreground">{props.config?.config_path || "Loading configuration…"}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={props.busy}
          onClick={() => props.onControl("reload_config", {}, "Reloading configuration…")}
        >
          <ArrowClockwiseIcon data-icon="inline-start" />
          Reload config
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="overflow-x-auto">
          <ChoiceGroup
            label="Configuration view"
            value={tab}
            onChange={setTab}
            options={[
              { value: "services", label: "Services" },
              { value: "sources", label: "Sources & overrides" },
              { value: "json", label: "JSON" },
              { value: "editor", label: "Edit config" },
            ]}
          />
        </div>
        {tab !== "json" && tab !== "editor" ? (
          <SearchInput
            label="Search configuration"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            className="w-full sm:w-72"
          />
        ) : null}
      </div>
      {tab === "services" ? (
        <div className="workspace-cards">
          {services.map((row) => (
            <Card key={row.name}>
              <CardHeader>
                <CardTitle>
                  <a href={hrefFor("services", row.name)} className="hover:text-primary">
                    {row.name}
                  </a>
                </CardTitle>
                <Badge variant="muted">{row.container ? "Container" : "Process"}</Badge>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">{row.description || "No description"}</p>
                <pre className="overflow-auto rounded-lg bg-muted p-3 font-mono text-[11px]">
                  {row.command?.join(" ") || row.container?.image || "—"}
                </pre>
                <p className="break-words text-[11px] text-muted-foreground">
                  {row.dependencies.length} dependencies · {row.ports?.length || 0} ports
                </p>
              </CardContent>
            </Card>
          ))}
          {services.length === 0 ? <Empty>No services match.</Empty> : null}
        </div>
      ) : tab === "sources" ? (
        <Card>
          <CardHeader>
            <CardTitle>Winning sources</CardTitle>
            <div className="flex gap-2">
              <FilterSelect
                label="Configuration layer"
                value={layer}
                onChange={setLayer}
                options={[
                  { value: "", label: "All layers" },
                  ...[...new Set(sources?.entries.map((entry) => entry.layer))].map((value) => ({ value, label: value })),
                ]}
              />
              <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {error ? (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : loading && !sources ? (
              <Empty>Loading sources…</Empty>
            ) : entries.length === 0 ? (
              <Empty>No configuration sources match.</Empty>
            ) : (
              <div className="config-sources">
                {entries.map((entry) => (
                  <div key={entry.path}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all font-mono text-xs text-primary">{entry.path}</span>
                      <Badge variant="muted">{entry.layer}</Badge>
                    </div>
                    <p className="break-all font-mono text-xs">{entry.value}</p>
                    <p className="break-all text-[11px] text-muted-foreground">{entry.source}</p>
                    {entry.shadowed.length ? (
                      <details>
                        <summary className="text-[11px] text-muted-foreground">{entry.shadowed.length} overridden sources</summary>
                        {entry.shadowed.map((source, index) => (
                          <p key={index} className="break-all pl-3 pt-1 text-[11px] text-muted-foreground">
                            {source.layer} · {source.source}
                          </p>
                        ))}
                      </details>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : tab === "json" ? (
        <Card>
          <CardContent className="pt-5">
            <JsonViewer title="Merged configuration summary" input={props.config} resetKey="config" />
          </CardContent>
        </Card>
      ) : null}
      <div hidden={tab !== "editor"}>
        <ConfigEditor active={props.active && tab === "editor"} onControl={props.onControl} />
      </div>
    </div>
  );
}
