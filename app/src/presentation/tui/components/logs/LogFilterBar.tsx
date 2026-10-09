import { SELECTABLE_LOG_LEVELS, canonicalLogLevel, type LogFacets, type LogRecord } from "../../../../domain/logs/logs.ts";
import { facetFilterCatalog, logFilterCatalog } from "../../helpers/logs.ts";
import { tabChipWidth } from "../../helpers/navigation.ts";
import { Chip, TabStrip, Toolbar } from "../../layout.tsx";
import { serviceColor, type Palette } from "../../themes.ts";

const COMPACT_WIDTH = 80;

const COMPACT_LEVEL: Record<string, string> = {
  TRACE: "trc",
  DEBUG: "dbg",
  INFO: "inf",
  WARN: "wrn",
  ERROR: "err",
  FATAL: "ftl",
};

export function LogFilterBar(props: {
  palette: Palette;
  logs: LogRecord[];
  names: string[];
  service: string;
  errorOnly: boolean;
  levels?: readonly string[];
  hideHealth?: boolean;
  width: number;
  onService: (service: string) => void;
  onToggleErrors: () => void;
  onToggleLevel?: (level: string) => void;
  onClearLevels?: () => void;
  onToggleHealth?: () => void;
  facets?: LogFacets;
}) {
  const {
    palette,
    logs,
    names,
    service,
    errorOnly,
    levels = [],
    hideHealth = false,
    width,
    onService,
    onToggleErrors,
    onToggleLevel,
    onClearLevels,
    onToggleHealth,
    facets,
  } = props;
  const sources = facets ? facetFilterCatalog(names, facets) : logFilterCatalog(names, logs);
  const compact = width < COMPACT_WIDTH;
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
  const healthLabel = hideHealth ? (compact ? "nohlth" : "health hidden") : compact ? "hlth" : "health";
  const stripWidth = Math.max(
    tabChipWidth(items[active]?.label ?? "all"),
    width - tabChipWidth(levelLabel) - tabChipWidth(healthLabel),
  );
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
          label={healthLabel}
          tone={hideHealth ? "warning" : "muted"}
          onMouseDown={onToggleHealth}
        />
        <Chip
          palette={palette}
          label={levelLabel}
          tone={errorOnly ? "error" : "muted"}
          onMouseDown={onToggleErrors}
        />
      </box>
      <box height={1} flexDirection="row" overflow="hidden" backgroundColor={palette.element}>
        <Chip
          palette={palette}
          label="all"
          tone={levels.length === 0 ? "primary" : "ghost"}
          onMouseDown={onClearLevels}
        />
        {SELECTABLE_LOG_LEVELS.map((level) => (
          <Chip
            key={level}
            palette={palette}
            label={levelChipLabel(level, compact, facets)}
            tone={levels.includes(level) ? levelTone(level) : "ghost"}
            onMouseDown={() => onToggleLevel?.(level)}
          />
        ))}
      </box>
    </Toolbar>
  );
}

function levelChipLabel(level: string, compact: boolean, facets: LogFacets | undefined): string {
  const name = compact ? COMPACT_LEVEL[level] ?? level : level.toLowerCase();
  const count = facetLevelCount(facets, level);
  if (compact || count === undefined) {
    return name;
  }
  return `${name} ${count}`;
}

function facetLevelCount(facets: LogFacets | undefined, level: string): number | undefined {
  if (!facets) {
    return undefined;
  }
  let total = 0;
  for (const [key, count] of Object.entries(facets.byLevel)) {
    if (canonicalLogLevel(key) === level) {
      total += count;
    }
  }
  return total;
}

function levelTone(level: string): "error" | "warning" | "info" | "muted" {
  if (level === "ERROR" || level === "FATAL") {
    return "error";
  }
  if (level === "WARN") {
    return "warning";
  }
  if (level === "INFO") {
    return "info";
  }
  return "muted";
}
