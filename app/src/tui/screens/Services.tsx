import { EmptyState } from "../chrome.tsx";
import { canStartAll, NARROW_WIDTH, SERVICE_LIST_MIN, serviceListInnerWidth, serviceListPaneWidth } from "../helpers.ts";
import { serviceColor, type Palette } from "../themes.ts";
import { type DevctlConfig } from "../../config/index.ts";
import { type StatusSnapshot } from "../../types.ts";
import { ServiceInspector } from "./ServiceDetail.tsx";
import { SelectionHint, ServiceRows } from "./ServiceRows.tsx";

const DETAIL_MIN_WIDTH = 36;
const DETAIL_STACK_MIN_HEIGHT = 12;

export function ServicesScreen(props: {
  palette: Palette;
  cfg?: DevctlConfig;
  names: string[];
  snap?: StatusSnapshot;
  selected: number;
  checked: string[];
  width: number;
  reveal: boolean;
  onOpen: (name: string) => void;
  onSelectIndex: (index: number) => void;
  onToggle: (name: string) => void;
  resolvedEnv?: Record<string, string>;
  envStatus?: "resolved" | "config" | "loading" | "error";
  envError?: string;
}) {
  const { palette, cfg, names, snap, selected, checked, width, reveal, onOpen, onSelectIndex, onToggle, resolvedEnv, envStatus, envError } = props;
  if (names.length === 0) {
    return <EmptyState palette={palette} title="No services" body="This configuration does not define any services." />;
  }
  const stacked = width < NARROW_WIDTH;
  const selectedName = names[selected] ?? "";
  const listWidth = serviceListPaneWidth(width, names, stacked);
  const paneGutter = 4;
  const detailWidth = stacked ? Math.max(DETAIL_MIN_WIDTH, width - paneGutter) : Math.max(DETAIL_MIN_WIDTH, width - listWidth - paneGutter);
  return (
    <box flexGrow={1} flexDirection={stacked ? "column" : "row"} overflow="hidden">
      <box
        flexGrow={stacked ? 1 : 0}
        flexShrink={0}
        minWidth={stacked ? undefined : SERVICE_LIST_MIN}
        width={stacked ? undefined : listWidth}
        border
        borderStyle="rounded"
        borderColor={palette.borderActive}
        backgroundColor={palette.panel}
        title="services"
        titleColor={palette.primary}
        flexDirection="column"
        overflow="hidden"
      >
        <SelectionHint palette={palette} checked={checked} idle={canStartAll(snap)} profileName="" members="" />
        <box flexGrow={1} overflow="hidden">
          <ServiceRows
            palette={palette}
            names={names}
            snap={snap}
            selected={selected}
            checked={checked}
            width={serviceListInnerWidth(listWidth)}
            onOpen={onOpen}
            onSelectIndex={onSelectIndex}
            onToggle={onToggle}
          />
        </box>
      </box>
      <box
        flexGrow={2}
        minWidth={stacked ? undefined : DETAIL_MIN_WIDTH}
        minHeight={stacked ? DETAIL_STACK_MIN_HEIGHT : undefined}
        border
        borderStyle="rounded"
        borderColor={palette.border}
        backgroundColor={palette.panel}
        title={selectedName || "detail"}
        titleColor={selectedName ? serviceColor(selectedName, palette) : palette.primary}
        overflow="hidden"
        flexDirection="column"
      >
        <ServiceInspector
          palette={palette}
          cfg={cfg}
          snap={snap}
          name={selectedName}
          reveal={reveal}
          width={detailWidth}
          resolvedEnv={resolvedEnv}
          envStatus={envStatus}
          envError={envError}
        />
      </box>
    </box>
  );
}
