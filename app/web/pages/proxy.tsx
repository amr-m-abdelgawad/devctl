import { McpControls } from "../components/mcp-controls.tsx";
import { JsonViewer } from "../components/json-viewer.tsx";
import { ChoiceGroup } from "../components/filters.tsx";
import { Fragment, useState } from "react";
import type { RunControl } from "../control.ts";
import { hrefFor } from "../hash.ts";
import { CaretRightIcon, PlayIcon, StopIcon } from "../icons.ts";
import { SearchInput } from "../components/filters.tsx";
import { Empty } from "../components/primitives.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import type { ConfigSummary, StatusSummary } from "../types.ts";

export function ProxyPage(props: { status?: StatusSummary; config?: ConfigSummary; busy: boolean; onControl: RunControl }) {
  const [tab, setTab] = useState("routes");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const routes = (props.config?.proxy?.routes ?? []).filter((row) =>
    `${row.name} ${routeMatchLabel(row.match)} ${row.upstream} ${row.auth}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="flex flex-col gap-5">
      <ChoiceGroup
        label="Connections view"
        value={tab}
        onChange={setTab}
        options={[
          { value: "routes", label: "Proxy & routes" },
          { value: "mcp", label: "MCP & agent tools" },
        ]}
      />
      {tab === "mcp" ? (
        <McpControls status={props.status} busy={props.busy} onControl={props.onControl} />
      ) : (
        <>
          <div className="workspace-cards">
            {[
              { name: "Proxy gateway", value: props.status?.proxy, description: "Routes local requests to configured upstreams." },
              { name: "MCP server", value: props.status?.mcp, description: "Connect coding agents to this workspace." },
              { name: "Web console", value: props.status?.web, description: "Your browser connection to the supervisor." },
            ].map((listener) => (
              <Card key={listener.name}>
                <CardHeader>
                  <CardTitle>{listener.name}</CardTitle>
                  <Badge variant={listener.value?.running ? "success" : "muted"}>{listener.value?.running ? "Running" : "Stopped"}</Badge>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <p className="text-xs text-muted-foreground">{listener.description}</p>
                  <p className="break-all font-mono text-xs">{listener.value?.address || "No active listener"}</p>
                  {listener.name === "Proxy gateway" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={props.busy || !props.status}
                      onClick={() => props.onControl(props.status?.proxy.running ? "stop_proxy" : "start_proxy", {}, "Updating proxy…")}
                    >
                      {props.status?.proxy.running ? <StopIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
                      {props.status?.proxy.running ? "Stop proxy" : "Start proxy"}
                    </Button>
                  ) : listener.name === "MCP server" ? (
                    <Button size="sm" variant="outline" onClick={() => setTab("mcp")}>
                      Manage connection & tools
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" asChild>
                      <a href={hrefFor("settings")}>Manage in settings</a>
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CardTitle>Proxy routes</CardTitle>
                <Badge variant="muted">{routes.length}</Badge>
              </div>
              <SearchInput
                label="Search routes, upstreams, auth…"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
                className="w-full sm:w-80"
              />
            </CardHeader>
            <CardContent className="pt-0">
              {routes.length === 0 ? (
                <Empty>{search ? "No routes match your search." : "No proxy routes configured."}</Empty>
              ) : (
                <div className="proxy-routes">
                  {routes.map((route) => {
                    const open = selected === route.name;
                    const match = routeMatchLabel(route.match);
                    return (
                      <Fragment key={route.name}>
                        <div className="proxy-route">
                          <div className="proxy-route-id">
                            <span className="truncate font-medium">{route.name}</span>
                            <Badge variant="muted">{route.transport === "grpc" ? "gRPC" : "HTTP"}</Badge>
                            <Badge variant="outline">{authLabel(route.auth)}</Badge>
                          </div>
                          <div className="proxy-route-actions">
                            <Button size="xs" variant="ghost" onClick={() => setSelected(open ? "" : route.name)}>
                              {open ? "Hide" : "Details"}
                            </Button>
                            <Button size="xs" variant="ghost" asChild>
                              <a href={hrefFor("traffic")}>Traffic</a>
                            </Button>
                          </div>
                          <div className="proxy-route-flow">
                            <code title={match}>{match}</code>
                            <CaretRightIcon className="size-3 shrink-0 text-primary" aria-hidden="true" />
                            <code title={route.upstream}>{route.upstream}</code>
                          </div>
                        </div>
                        {open ? (
                          <div className="proxy-route-detail">
                            {route.audience ? <p className="break-all text-xs text-muted-foreground">Audience: {route.audience}</p> : null}
                            {route.listen ? (
                              <p className="break-all font-mono text-xs text-muted-foreground">
                                Listen: {route.listen.host}:{route.listen.port}
                              </p>
                            ) : null}
                            <JsonViewer title={route.name} input={route} resetKey={route.name} />
                          </div>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function routeMatchLabel(match: NonNullable<ConfigSummary["proxy"]>["routes"][number]["match"]): string {
  return typeof match === "string" ? match || "/" : `${match.host || "*"}${match.path || "/"}`;
}

function authLabel(auth: string): string {
  if (!auth || auth.toLowerCase() === "none") {
    return "None";
  }
  return auth;
}
