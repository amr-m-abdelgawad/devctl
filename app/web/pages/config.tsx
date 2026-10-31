import { ConfigEditor } from "../components/config-editor.tsx";
import { Fragment, useCallback, useEffect, useState } from "react";
import { fetchConfigSources } from "../api.ts";
import { hrefFor } from "../hash.ts";
import { ArrowClockwiseIcon, CaretRightIcon } from "../icons.ts";
import { ChoiceGroup, FilterSelect, SearchInput } from "../components/filters.tsx";
import { JsonViewer } from "../components/json-viewer.tsx";
import { Empty } from "../components/primitives.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import type { ConfigService, ConfigSources, ConfigSummary } from "../types.ts";
import type { RunControl } from "../control.ts";

export function ConfigPage(props: { config?: ConfigSummary; active: boolean; busy: boolean; onControl: RunControl }) {
  const [tab, setTab] = useState("services");
  const [search, setSearch] = useState("");
  const [layer, setLayer] = useState("");
  const [openPath, setOpenPath] = useState("");
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
          <p className="break-all font-mono text-[12px] text-muted-foreground">{props.config?.config_path || "Loading configuration…"}</p>
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
        <Card>
          <CardContent className="pt-5">
            {services.length === 0 ? (
              <Empty>No services match.</Empty>
            ) : (
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[30%]">Service</TableHead>
                    <TableHead className="w-28">Run</TableHead>
                    <TableHead>Command</TableHead>
                    <TableHead className="w-16 text-right">Deps</TableHead>
                    <TableHead className="w-24">Ports</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {services.map((row) => {
                    const command = serviceCommand(row);
                    const ports = portNames(row.ports);
                    return (
                      <TableRow key={row.name}>
                        <TableCell className="max-w-[16rem]">
                          <a href={hrefFor("services", row.name)} className="font-medium hover:text-primary">
                            {row.name}
                          </a>
                          <p className="truncate text-xs text-muted-foreground" title={row.description || undefined}>
                            {row.description || "No description"}
                          </p>
                        </TableCell>
                        <TableCell>
                          <Badge variant="muted">{row.container ? "Container" : "Process"}</Badge>
                        </TableCell>
                        <TableCell className="max-w-[18rem] truncate font-mono text-xs" title={command}>
                          {command}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">{row.dependencies.length}</TableCell>
                        <TableCell className="max-w-[8rem] truncate font-mono text-xs text-muted-foreground" title={ports}>
                          {ports}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : tab === "sources" ? (
        <Card>
          <CardHeader>
            <div className="flex min-w-0 items-center gap-2">
              <CardTitle>Winning sources</CardTitle>
              {entries.length > 0 ? <Badge variant="muted">{entries.length}</Badge> : null}
            </div>
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
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[34%]">Key</TableHead>
                    <TableHead className="w-40">Layer</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead className="w-[18%]">From</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => {
                    const open = openPath === entry.path;
                    const from = sourceName(entry.source);
                    return (
                      <Fragment key={entry.path}>
                        <TableRow
                          className="cursor-pointer"
                          aria-expanded={open}
                          onClick={() => setOpenPath(open ? "" : entry.path)}
                        >
                          <TableCell className="max-w-0 overflow-hidden font-mono text-xs text-primary" title={entry.path}>
                            <span className="flex min-w-0 items-center gap-2">
                              <CaretRightIcon className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true" />
                              <span className="min-w-0 flex-1 truncate">{entry.path}</span>
                              {entry.shadowed.length ? (
                                <Badge variant="warning" className="shrink-0">{entry.shadowed.length}</Badge>
                              ) : null}
                            </span>
                          </TableCell>
                          <TableCell className="max-w-0 overflow-hidden">
                            <Badge variant="muted" className="max-w-full min-w-0 overflow-hidden" title={entry.layer}>
                              <span className="min-w-0 truncate">{entry.layer}</span>
                            </Badge>
                          </TableCell>
                          <TableCell className="max-w-0 overflow-hidden font-mono text-xs" title={entry.value}>
                            <span className="block truncate">{entry.value || "—"}</span>
                          </TableCell>
                          <TableCell className="max-w-0 overflow-hidden text-xs text-muted-foreground" title={entry.source}>
                            <span className="block truncate">{from}</span>
                          </TableCell>
                        </TableRow>
                        {open ? (
                          <TableRow>
                            <TableCell colSpan={4} className="bg-muted/30">
                              <div className="flex flex-col gap-3 py-1">
                                <p className="break-all font-mono text-xs">{entry.value || "—"}</p>
                                <p className="break-all text-xs text-muted-foreground">{entry.source}</p>
                                {entry.shadowed.length ? (
                                  <div className="flex flex-col gap-1">
                                    <p className="text-[12px] font-medium text-muted-foreground">Overridden</p>
                                    {entry.shadowed.map((source, index) => (
                                      <p key={index} className="break-all text-[12px] text-muted-foreground">
                                        {source.layer} · {sourceName(source.source)}
                                      </p>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
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

function serviceCommand(row: ConfigService): string {
  return row.command?.join(" ") || row.container?.image || "—";
}

function sourceName(source: string): string {
  const parts = source.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) || source || "—";
}

function portNames(ports: ConfigService["ports"]): string {
  if (!ports?.length) {
    return "—";
  }
  return ports.map((port) => port.name || String(port.value)).join(", ");
}
