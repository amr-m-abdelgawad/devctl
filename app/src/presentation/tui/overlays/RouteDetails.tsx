import { type Ref } from "react";
import { type ScrollBoxRenderable } from "@opentui/core";
import { OverlayShell, scrollboxStyle } from "../layout.tsx";
import { type Palette } from "../themes.ts";
import { type RouteDetailInfo } from "../screens/Proxy.tsx";

export function RouteDetailsOverlay(props: {
  palette: Palette;
  route?: RouteDetailInfo;
  termW: number;
  termH: number;
  scrollRef?: Ref<ScrollBoxRenderable>;
}) {
  const { palette, route, termW, termH, scrollRef } = props;
  if (!route) {
    return null;
  }
  return (
    <OverlayShell palette={palette} title={route.name} bottomTitle="j/k scroll  ·  esc close" termW={termW} termH={termH} preferW={78} preferH={16} gap={1}>
      <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
        <box flexDirection="column" overflow="hidden">
          <text fg={palette.muted}>{`auth        ${route.authType || "none"}`}</text>
          <text fg={palette.muted}>{`identity    ${route.identityType || "—"}`}</text>
          <text fg={palette.text} wrapMode="word">{`account     ${route.serviceAccount || "—"}`}</text>
          <text fg={palette.text} wrapMode="word">{`audience    ${route.audience || "—"}`}</text>
          <text fg={palette.muted}>{`match host  ${route.matchHost || "*"}`}</text>
          <text fg={palette.muted}>{`match path  ${route.matchPath || "*"}`}</text>
          <text fg={palette.text} wrapMode="word">{`upstream    ${route.upstream}`}</text>
        </box>
      </scrollbox>
    </OverlayShell>
  );
}
