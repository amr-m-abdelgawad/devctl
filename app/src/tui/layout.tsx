import { type ReactNode, useEffect, useRef } from "react";
import { type ScrollBoxRenderable } from "@opentui/core";
import { useDensity } from "./density.tsx";
import { isCompactScale, isTightScale } from "./settings.ts";
import { type Palette } from "./themes.ts";
import { overlayRect, tabChipWidth, visibleTabRange } from "./helpers.ts";

export type ChipTone = "primary" | "accent" | "success" | "warning" | "error" | "info" | "muted" | "idle";

function chipColors(palette: Palette, tone: ChipTone): { bg: string; fg: string } {
  switch (tone) {
    case "primary":
      return { bg: palette.primary, fg: palette.inverse };
    case "accent":
      return { bg: palette.accent, fg: palette.inverse };
    case "success":
      return { bg: palette.success, fg: palette.inverse };
    case "warning":
      return { bg: palette.warning, fg: palette.inverse };
    case "error":
      return { bg: palette.error, fg: palette.inverse };
    case "info":
      return { bg: palette.info, fg: palette.inverse };
    case "muted":
      return { bg: palette.element, fg: palette.text };
    default:
      return { bg: palette.element, fg: palette.text };
  }
}

function OverflowMark(props: { palette: Palette; dir: "left" | "right" }) {
  const { palette, dir } = props;
  return (
    <box width={2} height={1} flexShrink={0} overflow="hidden">
      <text fg={palette.muted}>{dir === "left" ? "‹" : "›"}</text>
    </box>
  );
}

export function Toolbar(props: {
  palette: Palette;
  children?: ReactNode;
  backgroundColor?: string;
  edge?: "top" | "bottom" | "both";
  ruled?: boolean;
}) {
  const { palette, children, backgroundColor, edge = "bottom" } = props;
  const scale = useDensity();
  const ruled = props.ruled ?? !isCompactScale(scale);
  const fill = backgroundColor ?? palette.element;
  const body = (
    <box flexShrink={0} flexDirection="column" backgroundColor={fill} overflow="hidden">
      {children}
    </box>
  );
  if (!ruled) {
    return body;
  }
  const sides = edge === "both" ? (["top", "bottom"] as const) : ([edge] as const);
  return (
    <box
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
      border={[...sides]}
      borderStyle="single"
      borderColor={palette.border}
    >
      {body}
    </box>
  );
}

export function TabStrip(props: {
  palette: Palette;
  items: { id: string; label: string; color?: string }[];
  active: number;
  width: number;
  onPick: (index: number) => void;
}) {
  const { palette, items, active, width, onPick } = props;
  const widths = items.map((item) => tabChipWidth(item.label));
  const range = visibleTabRange(widths, active, Math.max(1, width));
  const moreLeft = range.start > 0;
  const moreRight = range.end >= 0 && range.end < items.length - 1;
  return (
    <box height={1} flexDirection="row" overflow="hidden" backgroundColor={palette.element}>
      {moreLeft ? <OverflowMark palette={palette} dir="left" /> : null}
      {items.map((item, index) => {
        if (index < range.start || index > range.end) {
          return null;
        }
        const selected = index === active;
        return (
          <Chip
            key={item.id}
            palette={palette}
            label={item.label}
            tone={selected ? "primary" : "muted"}
            fg={selected ? undefined : item.color}
            onMouseDown={() => onPick(index)}
          />
        );
      })}
      {moreRight ? <OverflowMark palette={palette} dir="right" /> : null}
    </box>
  );
}

export function Chip(props: {
  palette: Palette;
  label: string;
  tone?: ChipTone;
  fg?: string;
  bg?: string;
  onMouseDown?: () => void;
}) {
  const { palette, label, tone = "idle", fg, bg, onMouseDown } = props;
  const colors = chipColors(palette, tone);
  return (
    <box
      height={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={bg ?? colors.bg}
      overflow="hidden"
      flexShrink={0}
      onMouseDown={onMouseDown}
    >
      <text fg={fg ?? colors.fg}>{label}</text>
    </box>
  );
}

export type MetaChip = {
  text: string;
  tone?: ChipTone;
  onMouseDown?: () => void;
};

export type KeyHintItem = {
  key: string;
  label: string;
};

export function KeyHints(props: { palette: Palette; hints: KeyHintItem[] }) {
  const { palette, hints } = props;
  return (
    <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
      {hints.map((hint) => (
        <box key={`${hint.key}-${hint.label}`} height={1} paddingLeft={1} paddingRight={1} flexShrink={0} overflow="hidden">
          <text wrapMode="none">
            <span fg={palette.primary}>{hint.key}</span>
            <span fg={palette.muted}>{` ${hint.label}`}</span>
          </text>
        </box>
      ))}
    </box>
  );
}

export function MetaBar(props: { palette: Palette; items: MetaChip[]; hints?: KeyHintItem[]; ruled?: boolean }) {
  const { palette, items, hints, ruled = true } = props;
  const row = (
    <box height={1} flexDirection="row" overflow="hidden" backgroundColor={palette.element}>
      {items.map((item, index) => (
        <Chip key={`${item.text}-${index}`} palette={palette} label={item.text} tone={item.tone} onMouseDown={item.onMouseDown} />
      ))}
      {hints && hints.length > 0 ? (
        <>
          <box flexGrow={1} backgroundColor={palette.element} />
          <KeyHints palette={palette} hints={hints} />
        </>
      ) : null}
    </box>
  );
  if (!ruled) {
    return row;
  }
  return (
    <Toolbar palette={palette} backgroundColor={palette.element}>
      {row}
    </Toolbar>
  );
}

export const ROUNDED_BORDER = "rounded";

export function OverlayShell(props: {
  palette: Palette;
  title: string;
  termW: number;
  termH: number;
  preferW: number;
  preferH: number;
  anchor?: "center" | "bottom";
  borderColor?: string;
  bottomTitle?: string;
  gap?: number;
  children?: ReactNode;
}) {
  const { palette, title, termW, termH, preferW, preferH, anchor = "center", borderColor, bottomTitle, gap, children } = props;
  const compact = isCompactScale(useDensity());
  const rect = overlayRect(termW, termH, preferW, preferH, anchor, !compact);
  return (
    <box
      position="absolute"
      left={rect.left}
      top={rect.top}
      width={rect.width}
      height={rect.height}
      border
      borderStyle={ROUNDED_BORDER}
      borderColor={borderColor ?? palette.borderActive}
      backgroundColor={palette.panel}
      padding={compact ? 0 : 1}
      title={title}
      titleColor={palette.primary}
      bottomTitle={bottomTitle}
      gap={compact ? 0 : gap}
      flexDirection="column"
      overflow="hidden"
    >
      {children}
    </box>
  );
}

export function scrollboxStyle(palette: Palette): {
  rootOptions: { flexGrow: number; height: `${number}%`; overflow: "hidden"; backgroundColor: string };
  viewportOptions: { backgroundColor: string };
  contentOptions: { backgroundColor: string };
  scrollbarOptions: { trackOptions: { foregroundColor: string; backgroundColor: string } };
} {
  return {
    rootOptions: { flexGrow: 1, height: "100%", overflow: "hidden", backgroundColor: palette.panel },
    viewportOptions: { backgroundColor: palette.panel },
    contentOptions: { backgroundColor: palette.panel },
    scrollbarOptions: {
      trackOptions: { foregroundColor: palette.primary, backgroundColor: palette.element },
    },
  };
}

export function scrollBoxBy(box: ScrollBoxRenderable | null, delta: number): void {
  if (!box) {
    return;
  }
  box.scrollBy({ x: 0, y: delta });
}

export function useScrollSelectedIntoView(selected: number, idPrefix: string) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  useEffect(() => {
    const box = scrollRef.current;
    if (!box || selected < 0) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      box.scrollChildIntoView(`${idPrefix}-${selected}`);
    });
    return () => cancelAnimationFrame(frame);
  }, [idPrefix, selected]);
  return scrollRef;
}

export function ScreenFrame(props: {
  palette: Palette;
  title: string;
  borderColor?: string;
  scroll?: boolean;
  children?: ReactNode;
}) {
  const scale = useDensity();
  const tight = isTightScale(scale);
  const body = props.scroll ? (
    <scrollbox focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(props.palette)}>
      <box flexDirection="column" overflow="hidden">
        {props.children}
      </box>
    </scrollbox>
  ) : (
    props.children
  );
  return (
    <box
      flexGrow={1}
      border
      borderStyle={ROUNDED_BORDER}
      borderColor={props.borderColor ?? props.palette.border}
      title={props.title}
      titleColor={props.palette.primary}
      paddingLeft={scale.pad}
      paddingRight={scale.pad}
      paddingTop={tight ? 0 : scale.pad}
      paddingBottom={tight ? 0 : scale.pad}
      backgroundColor={props.palette.panel}
      flexDirection="column"
      overflow="hidden"
    >
      {body}
    </box>
  );
}

export function FieldRow(props: { palette: Palette; label: string; value: string; tone?: "text" | "success" | "warning" | "error" | "muted" }) {
  const { palette, label, value, tone = "text" } = props;
  const scale = useDensity();
  const valueFg =
    tone === "success"
      ? palette.success
      : tone === "warning"
        ? palette.warning
        : tone === "error"
          ? palette.error
          : tone === "muted"
            ? palette.muted
            : palette.text;
  return (
    <box height={scale.rowH} flexDirection="row" overflow="hidden">
      <box width={14} flexShrink={0} overflow="hidden">
        <text fg={palette.muted}>{label}</text>
      </box>
      <box flexGrow={1} overflow="hidden">
        <text fg={valueFg} wrapMode="none">
          {value}
        </text>
      </box>
    </box>
  );
}

export function Banner(props: { palette: Palette; title: string; body: string; hint?: string }) {
  const { palette, title, body, hint } = props;
  return (
    <box
      height={hint ? 5 : 4}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      overflow="hidden"
      border
      borderStyle={ROUNDED_BORDER}
      borderColor={palette.borderActive}
      titleColor={palette.primary}
    >
      <text fg={palette.primary}>{title}</text>
      <text fg={palette.text} wrapMode="word">
        {body}
      </text>
      {hint ? (
        <text fg={palette.muted} wrapMode="word">
          {hint}
        </text>
      ) : null}
    </box>
  );
}
