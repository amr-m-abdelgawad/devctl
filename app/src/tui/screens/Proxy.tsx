import { EmptyState } from "../chrome.tsx";
import { Chip, KeyHints, MetaBar, ScreenFrame, Toolbar } from "../layout.tsx";
import { type Palette } from "../themes.ts";
import { type DevctlConfig } from "../../config/index.ts";
import { type StatusSnapshot } from "../../types.ts";

function authTone(auth: string): "info" | "primary" | "idle" {
  const lower = auth.toLowerCase();
  if (lower === "iap") {
    return "info";
  }
  if (lower === "service" || lower === "service_account") {
    return "primary";
  }
  return "idle";
}

export function ProxyScreen(props: { palette: Palette; cfg?: DevctlConfig; snap?: StatusSnapshot }) {
  const { palette, cfg, snap } = props;
  const routes = snap?.proxy.routes ?? [];
  const matchByName = new Map((cfg?.proxy.routes ?? []).map((r) => [r.name, r.match]));
  return (
    <ScreenFrame palette={palette} title="proxy">
      <MetaBar
        palette={palette}
        items={[
          { text: snap?.proxy.running ? "RUNNING" : "STOPPED", tone: snap?.proxy.running ? "success" : "idle" },
          ...(snap?.proxy.address ? [{ text: snap.proxy.address, tone: "info" as const }] : []),
          { text: `${routes.length} routes`, tone: routes.length > 0 ? "primary" : "idle" },
        ]}
      />
      <box flexGrow={1} overflow="hidden">
        {routes.length === 0 ? (
          <EmptyState palette={palette} title="No proxy routes" body="Add routes under proxy.routes or .devctl/proxy/routes.yaml." />
        ) : (
          <scrollbox focused={false} stickyScroll={false} scrollX={false} style={{ rootOptions: { overflow: "hidden" } }}>
            <box flexDirection="column" overflow="hidden" gap={1}>
              {routes.map((r) => {
                const match = matchByName.get(r.name);
                return (
                  <box
                    key={r.name}
                    border
                    borderStyle="rounded"
                    borderColor={palette.border}
                    title={r.name}
                    titleColor={palette.text}
                    flexDirection="column"
                    flexShrink={0}
                    paddingLeft={1}
                    paddingRight={1}
                    overflow="hidden"
                  >
                    <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
                      <Chip palette={palette} label={r.auth || "no auth"} tone={authTone(r.auth)} />
                      {r.identity ? <Chip palette={palette} label={r.identity} tone="idle" /> : null}
                    </box>
                    {match && (match.host || match.path) ? (
                      <text fg={palette.muted} wrapMode="none">
                        {`match: ${match.host || "*"}${match.path ? match.path : ""}`}
                      </text>
                    ) : null}
                    <text fg={palette.text} wrapMode="none">
                      {`→ ${r.upstream}`}
                    </text>
                  </box>
                );
              })}
            </box>
          </scrollbox>
        )}
      </box>
      <Toolbar palette={palette} backgroundColor={palette.element} edge="top">
        <KeyHints
          palette={palette}
          hints={[
            { key: "n", label: "start proxy" },
            { key: "x", label: "stop proxy" },
          ]}
        />
      </Toolbar>
    </ScreenFrame>
  );
}
