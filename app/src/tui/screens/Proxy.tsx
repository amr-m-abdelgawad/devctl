import { useTerminalDimensions } from "@opentui/react";
import { EmptyState } from "../chrome.tsx";
import { useDensity } from "../density.tsx";
import { KeyHints, MetaBar, ScreenFrame, Toolbar } from "../layout.tsx";
import { type Palette } from "../themes.ts";
import { type StatusSnapshot } from "../../types.ts";

const WIDE_ROUTE = 80;
const NAME_WIDE = 14;
const NAME_NARROW = 10;
const IDENTITY_WIDE = 16;
const IDENTITY_NARROW = 12;
const AUTH_WIDE = 10;
const AUTH_NARROW = 8;

export function ProxyScreen(props: { palette: Palette; snap?: StatusSnapshot }) {
  const { palette, snap } = props;
  const scale = useDensity();
  const { width } = useTerminalDimensions();
  const compact = width < WIDE_ROUTE;
  const routes = snap?.proxy.routes ?? [];
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
            <box flexDirection="column" overflow="hidden">
              {routes.map((r) => (
                <box key={r.name} height={scale.rowH} flexDirection="row" overflow="hidden">
                  <box width={compact ? NAME_NARROW : NAME_WIDE} flexShrink={0} overflow="hidden">
                    <text fg={palette.text}>{r.name}</text>
                  </box>
                  <box width={compact ? IDENTITY_NARROW : IDENTITY_WIDE} flexShrink={0} overflow="hidden">
                    <text fg={palette.info}>{r.identity}</text>
                  </box>
                  <box width={compact ? AUTH_NARROW : AUTH_WIDE} flexShrink={0} overflow="hidden">
                    <text fg={palette.primary}>{r.auth}</text>
                  </box>
                  <box flexGrow={1} overflow="hidden">
                    <text fg={palette.text} wrapMode="none">
                      {r.upstream}
                    </text>
                  </box>
                </box>
              ))}
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
