import { type LogRecord, type LogFacets } from "../../../../domain/logs/logs.ts";
import { facetFilterCatalog, logFilterCatalog } from "../../helpers/logs.ts";
import { tabChipWidth } from "../../helpers/navigation.ts";
import { Chip, TabStrip, Toolbar } from "../../layout.tsx";
import { serviceColor, type Palette } from "../../themes.ts";

export function LogFilterBar(props: {
  palette: Palette;
  logs: LogRecord[];
  names: string[];
  service: string;
  errorOnly: boolean;
  width: number;
  onService: (service: string) => void;
  onToggleErrors: () => void;
  facets?: LogFacets;
}) {
  const { palette, logs, names, service, errorOnly, width, onService, onToggleErrors, facets } = props;
  const sources = facets ? facetFilterCatalog(names, facets) : logFilterCatalog(names, logs);
  const compact = width < 80;
  const items = sources.map((item) => {
    const name = item.name === "" ? "all" : item.name;
    return {
      id: name,
      label: compact ? name : `${name} · ${item.count}`,
      color: serviceColor(item.name, palette),
    };
  });
  const active = Math.max(0, sources.findIndex((item) => item.name === service));
  const levelLabel = errorOnly ? "ERROR+" : compact ? "lvls" : "all levels";
  const stripWidth = Math.max(tabChipWidth(items[active]?.label ?? "all"), width - tabChipWidth(levelLabel));
  return (
    <Toolbar palette={palette} backgroundColor={palette.element}>
    <box height={1} flexDirection="row" overflow="hidden" backgroundColor={palette.element}>
      <box flexGrow={1} overflow="hidden">
        <TabStrip
          palette={palette}
          items={items}
          active={active}
          width={stripWidth}
          emphasis="fill"
          onPick={(index) => {
            const item = sources[index];
            if (item) {
              onService(item.name);
            }
          }}
        />
      </box>
      <Chip
        palette={palette}
        label={levelLabel}
        tone={errorOnly ? "error" : "muted"}
        onMouseDown={onToggleErrors}
      />
    </box>
    </Toolbar>
  );
}
