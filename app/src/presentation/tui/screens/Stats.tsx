import { type ReactNode, useEffect, useState } from "react";
import { EmptyState } from "../chrome.tsx";
import {
  credentialStoreLabel,
  factTableColumns,
  fleetFacts,
  formatCpuPercent,
  formatMemoryKB,
  formatResourceMeter,
  formatUptime,
  leftoverCopy,
  loadCopy,
  padClip,
  platformLabel,
  renderBar,
  runtimeUptime,
  SERVICE_COL_GAP,
  SERVICE_CPU_COL,
  SERVICE_HEALTH_COL,
  SERVICE_MEM_COL,
  SERVICE_PID_COL,
  SERVICE_STATE_COL,
  SERVICE_UPTIME_COL,
  STATS_FACT_GAP,
  STATS_RESTARTS_COL,
  serviceCheckLabel,
  serviceFleetStats,
  serviceStatusLabel,
  statsPaneWidth,
  statsServiceColumns,
  topLogSources,
  usesTrafficHealth,
  wrapLogMessage,
  type ResourceTone,
  type StatsFact,
} from "../helpers.ts";
import { useDensity } from "../density.tsx";
import { ScreenFrame } from "../layout.tsx";
import { serviceColor, stateColor, type Palette } from "../themes.ts";
import { sessionStartedAt } from "../../../adapters/storage/storage.ts";
import { type DevctlConfig } from "../../../adapters/config/index.ts";
import { type Runtime } from "../../../domain/service/services.ts";
import { type StatusSnapshot } from "../../../types.ts";

const TICK_MS = 1000;
const REFRESH_EVERY_N_TICKS = 5;
const BAR_LEN = 16;
const MS_PER_SEC = 1000;

function Section(props: {
  palette: Palette;
  title: string;
  tone?: "success" | "warning" | "error" | "muted";
  children: ReactNode;
}) {
  const { palette, title, tone = "muted", children } = props;
  const borderColor =
    tone === "success" ? palette.success : tone === "warning" ? palette.warning : tone === "error" ? palette.error : palette.border;
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={borderColor}
      title={title}
      titleColor={borderColor}
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      marginBottom={1}
      overflow="hidden"
    >
      {children}
    </box>
  );
}

type CellTone = ResourceTone | "muted" | "text" | "primary";

type TableCell = {
  text: string;
  width: number;
  tone?: CellTone;
  color?: string;
};

function cellFg(palette: Palette, cell: TableCell): string {
  if (cell.color) {
    return cell.color;
  }
  switch (cell.tone) {
    case "success":
      return palette.success;
    case "warning":
      return palette.warning;
    case "error":
      return palette.error;
    case "primary":
      return palette.primary;
    case "muted":
      return palette.muted;
    default:
      return palette.text;
  }
}

function TableRow(props: { palette: Palette; cells: TableCell[]; header?: boolean; gap?: number; stripe?: boolean }) {
  const { palette, cells, header, gap = 0, stripe } = props;
  return (
    <box height={1} flexDirection="row" overflow="hidden" flexShrink={0} backgroundColor={stripe ? palette.element : undefined}>
      {cells.map((cell, index) => (
        <box key={`${cell.text}-${index}`} flexDirection="row" flexShrink={0} overflow="hidden">
          {index > 0 && gap > 0 ? <box width={gap} flexShrink={0} /> : null}
          <box width={cell.width} flexShrink={0} overflow="hidden">
            <text fg={header ? palette.primary : cellFg(palette, cell)} wrapMode="none">
              {padClip(cell.text, cell.width)}
            </text>
          </box>
        </box>
      ))}
    </box>
  );
}

function HeaderRule(props: { palette: Palette; width: number }) {
  const { palette, width } = props;
  return (
    <box height={1} flexShrink={0} overflow="hidden">
      <text fg={palette.border} wrapMode="none">
        {padClip("─".repeat(Math.max(1, width)), width)}
      </text>
    </box>
  );
}

function FactTable(props: { palette: Palette; facts: StatsFact[]; width: number }) {
  const { palette, facts, width } = props;
  const cols = factTableColumns(facts, width);
  const header: TableCell[] = [
    { text: "what", width: cols.what },
    { text: "reading", width: cols.reading },
  ];
  if (cols.meter > 0) {
    header.push({ text: "used", width: cols.meter });
  }
  header.push({ text: "meaning", width: cols.meaning });
  return (
    <box flexDirection="column" overflow="hidden" flexShrink={0}>
      <TableRow palette={palette} header gap={STATS_FACT_GAP} cells={header} />
      <HeaderRule palette={palette} width={width} />
      {facts.map((fact, index) => {
        const lines = fact.meaning === "" ? [""] : wrapLogMessage(fact.meaning, Math.max(1, cols.meaning));
        const meterText = fact.meter ? formatResourceMeter(fact.meter) : cols.meter > 0 ? "" : undefined;
        const body: TableCell[] = [
          { text: fact.what, width: cols.what, tone: "text" },
          { text: fact.reading, width: cols.reading, tone: fact.tone ?? "text" },
        ];
        if (cols.meter > 0) {
          body.push({ text: meterText ?? "", width: cols.meter, tone: fact.meter ? fact.tone ?? "text" : "muted" });
        }
        body.push({ text: lines[0] ?? "", width: cols.meaning, tone: "muted" });
        return (
          <box key={`${fact.what}-${fact.reading}-${index}`} flexDirection="column" overflow="hidden" flexShrink={0}>
            <TableRow palette={palette} gap={STATS_FACT_GAP} stripe={index % 2 === 1} cells={body} />
            {lines.slice(1).map((line, lineIndex) => {
              const extra: TableCell[] = [
                { text: "", width: cols.what },
                { text: "", width: cols.reading },
              ];
              if (cols.meter > 0) {
                extra.push({ text: "", width: cols.meter });
              }
              extra.push({ text: line, width: cols.meaning, tone: "muted" });
              return <TableRow key={`${fact.what}-more-${lineIndex}`} palette={palette} gap={STATS_FACT_GAP} stripe={index % 2 === 1} cells={extra} />;
            })}
          </box>
        );
      })}
    </box>
  );
}

export function StatsScreen(props: {
  palette: Palette;
  cfg?: DevctlConfig;
  snap?: StatusSnapshot;
  width: number;
  onRefresh?: () => void;
}) {
  const { palette, cfg, snap, width, onRefresh } = props;
  const scale = useDensity();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setTick((tick) => {
        const next = tick + 1;
        if (onRefresh && next % REFRESH_EVERY_N_TICKS === 0) {
          onRefresh();
        }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [onRefresh]);

  if (!cfg) {
    return <EmptyState palette={palette} title="No configuration loaded" body="Add services to .devctl/config.yaml or finish setup." />;
  }

  const names = Object.keys(cfg.services).sort();
  const probes = names.some((name) => usesTrafficHealth(cfg.services[name]));
  const fleet = serviceFleetStats(names, snap);
  const fleetRows = fleetFacts(fleet, probes);
  const healthRatio = probes && fleet.live > 0 ? fleet.healthy / fleet.live : fleet.total > 0 ? fleet.live / fleet.total : 0;
  const bar = renderBar(healthRatio, BAR_LEN);
  const barTone: ResourceTone = fleet.failed > 0 ? "error" : probes && fleet.live > 0 && fleet.healthy < fleet.live ? "warning" : "success";
  const inner = statsPaneWidth(width, scale.pad);

  const sessionStart = snap?.session_id ? sessionStartedAt(snap.session_id) : undefined;
  const sessionUptime = sessionStart ? formatUptime(Date.now() - sessionStart.getTime()) : "just started";

  const logsTotal = snap?.logs.total ?? 0;
  const logsErrors = snap?.logs.errors ?? 0;
  const sources = topLogSources(snap?.logs.counts ?? {});

  const routes = snap?.proxy.routes ?? [];
  const creds = snap?.credentials;
  const validCreds = (creds?.entries ?? []).filter((entry) => entry.valid).length;

  const sys = snap?.system;
  const leftoverKB = sys ? (sys.memAvailableKB ?? sys.memFreeKB) : 0;
  const cpuFact = sys ? loadCopy(sys.loadAvg1, sys.cpuCount) : undefined;
  const ramFact = sys ? leftoverCopy(leftoverKB, sys.memTotalKB) : undefined;
  const computerFacts: StatsFact[] = [];
  if (sys && cpuFact && ramFact) {
    computerFacts.push(cpuFact, ramFact, {
      what: "Computer",
      reading: platformLabel(sys.platform),
      meaning: `on for ${formatUptime(sys.hostUptimeSec * MS_PER_SEC)}`,
      tone: "text",
    });
  }
  const sectionTone =
    fleet.failed > 0 || cpuFact?.tone === "error" || ramFact?.tone === "error"
      ? "error"
      : barTone === "warning" || cpuFact?.tone === "warning" || ramFact?.tone === "warning"
        ? "warning"
        : "success";

  const sessionFacts: StatsFact[] = [
    { what: "This session", reading: sessionUptime, meaning: "how long this run has been going", tone: "text" },
    { what: "Profile", reading: snap?.profile || "none", meaning: "which group of services is selected", tone: snap?.profile ? "text" : "muted" },
    {
      what: "This window",
      reading: snap?.detached ? "closed" : "watching",
      meaning: snap?.detached ? "services keep running without this screen" : "you are watching the services from here",
      tone: snap?.detached ? "warning" : "text",
    },
    { what: "Project folder", reading: "", meaning: cfg.repoRoot, tone: "muted" },
  ];

  const logFacts: StatsFact[] = [
    { what: "Lines kept", reading: String(logsTotal), meaning: "log lines still in memory", tone: "text" },
    {
      what: "Error lines",
      reading: String(logsErrors),
      meaning: logsErrors > 0 ? "open Logs and press e to see only errors" : "no ERROR or FATAL lines",
      tone: logsErrors > 0 ? "error" : "muted",
    },
    ...sources.map(([name, count]) => ({
      what: name,
      reading: String(count),
      meaning: "lines from this service",
      tone: "text" as const,
    })),
  ];

  const otherFacts: StatsFact[] = [
    {
      what: "Web proxy",
      reading: snap?.proxy.running ? "on" : "off",
      meaning: snap?.proxy.running
        ? `${routes.length} apps${snap.proxy.address ? ` at ${snap.proxy.address}` : ""}`
        : "not forwarding local URLs",
      tone: snap?.proxy.running ? "success" : "muted",
    },
    {
      what: "Agent tools",
      reading: snap?.mcp?.running ? "on" : "off",
      meaning: snap?.mcp?.address ? `Cursor talks to devctl at ${snap.mcp.address}` : "turn on from Settings → MCP",
      tone: snap?.mcp?.running ? "success" : "muted",
    },
    {
      what: "Google account",
      reading: snap?.identity.user ? "signed in" : "not signed in",
      meaning: [snap?.identity.user, snap?.identity.project].filter(Boolean).join("  ·  ") || "no Google user for this session",
      tone: snap?.identity.user ? "success" : "muted",
    },
    {
      what: "Saved tokens",
      reading: creds ? `${validCreds} of ${creds.entries.length} good` : "none",
      meaning: creds ? credentialStoreLabel(creds.backend) : "nothing stored yet",
      tone: creds && validCreds < creds.entries.length ? "warning" : creds ? "success" : "muted",
    },
  ];

  return (
    <ScreenFrame palette={palette} title="stats" scroll>
      <Section palette={palette} title={`Your services  ${fleet.live} of ${fleet.total} started`} tone={sectionTone}>
        <FactTable palette={palette} facts={fleetRows} width={inner} />
        <box height={1} flexShrink={0} />
        <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
          <text wrapMode="none">
            <span fg={palette.muted}>{padClip(probes ? "Ready" : "Started", factTableColumns(fleetRows, inner).what)}</span>
            <span>{" ".repeat(STATS_FACT_GAP)}</span>
            <span fg={cellFg(palette, { text: "", width: 1, tone: barTone })}>{`[${bar}]`}</span>
            <span fg={cellFg(palette, { text: "", width: 1, tone: barTone })}>
              {probes ? `  ${fleet.healthy} of ${fleet.live || fleet.total} passing checks` : `  ${fleet.live} of ${fleet.total} up`}
            </span>
          </text>
        </box>
      </Section>

      {sys ? (
        <Section palette={palette} title="This computer" tone={cpuFact?.tone === "error" || ramFact?.tone === "error" ? "error" : cpuFact?.tone === "warning" || ramFact?.tone === "warning" ? "warning" : "success"}>
          <FactTable palette={palette} facts={computerFacts} width={inner} />
        </Section>
      ) : null}

      <Section palette={palette} title="This session">
        <FactTable palette={palette} facts={sessionFacts} width={inner} />
      </Section>

      <Section palette={palette} title="Each service" tone={fleet.failed > 0 ? "error" : probes && fleet.live > 0 && fleet.healthy < fleet.live ? "warning" : "success"}>
        {fleet.total === 0 ? (
          <text fg={palette.muted}>No services in this project yet.</text>
        ) : (
          <box flexDirection="column" overflow="hidden" flexShrink={0}>
            <ServiceTable palette={palette} names={names} snap={snap} width={inner} />
            <box height={1} flexShrink={0} />
            <text fg={palette.muted} wrapMode="none">
              {padClip("CPU is % of one core. RAM is what that process is holding now.", inner)}
            </text>
          </box>
        )}
      </Section>

      <Section palette={palette} title="Log lines" tone={logsErrors > 0 ? "warning" : "muted"}>
        <FactTable palette={palette} facts={logFacts} width={inner} />
      </Section>

      <Section palette={palette} title="Other parts">
        <FactTable palette={palette} facts={otherFacts} width={inner} />
      </Section>
    </ScreenFrame>
  );
}

function ServiceTable(props: { palette: Palette; names: string[]; snap?: StatusSnapshot; width: number }) {
  const { palette, names, snap, width } = props;
  const cols = statsServiceColumns(width);
  const header: TableCell[] = [
    { text: "service", width: cols.name },
    { text: "status", width: SERVICE_STATE_COL },
  ];
  if (cols.health) {
    header.push({ text: "check", width: SERVICE_HEALTH_COL });
  }
  if (cols.cpu) {
    header.push({ text: "cpu", width: SERVICE_CPU_COL });
  }
  if (cols.mem) {
    header.push({ text: "ram", width: SERVICE_MEM_COL });
  }
  if (cols.up) {
    header.push({ text: "up", width: SERVICE_UPTIME_COL });
  }
  if (cols.rst) {
    header.push({ text: "restarts", width: STATS_RESTARTS_COL });
  }
  if (cols.pid) {
    header.push({ text: "pid", width: SERVICE_PID_COL });
  }
  return (
    <box flexDirection="column" overflow="hidden" flexShrink={0}>
      <TableRow palette={palette} header gap={SERVICE_COL_GAP} cells={header} />
      <HeaderRule palette={palette} width={width} />
      {names.map((name, index) => (
        <ServiceTableRow key={name} palette={palette} name={name} rt={snap?.services[name]} cols={cols} stripe={index % 2 === 1} />
      ))}
    </box>
  );
}

const CPU_BUSY = 80;
const CPU_HOT = 100;

function cpuCellTone(pct?: number): CellTone {
  if (pct === undefined) {
    return "muted";
  }
  if (pct > CPU_HOT) {
    return "error";
  }
  if (pct > CPU_BUSY) {
    return "warning";
  }
  return "text";
}

function ServiceTableRow(props: {
  palette: Palette;
  name: string;
  rt?: Runtime;
  cols: ReturnType<typeof statsServiceColumns>;
  stripe?: boolean;
}) {
  const { palette, name, rt, cols, stripe } = props;
  const status = serviceStatusLabel(rt);
  const check = serviceCheckLabel(rt);
  const restarts = rt?.restarts ?? 0;
  const cells: TableCell[] = [
    { text: name, width: cols.name, color: serviceColor(name, palette) },
    { text: status, width: SERVICE_STATE_COL, color: stateColor(palette, rt?.state ?? "STOPPED") },
  ];
  if (cols.health) {
    cells.push({ text: check, width: SERVICE_HEALTH_COL, color: stateColor(palette, rt?.health ?? "UNKNOWN") });
  }
  if (cols.cpu) {
    cells.push({
      text: rt?.cpuPercent !== undefined ? formatCpuPercent(rt.cpuPercent) : "—",
      width: SERVICE_CPU_COL,
      tone: cpuCellTone(rt?.cpuPercent),
    });
  }
  if (cols.mem) {
    cells.push({ text: rt?.memoryKB !== undefined ? formatMemoryKB(rt.memoryKB) : "—", width: SERVICE_MEM_COL, tone: "text" });
  }
  if (cols.up) {
    cells.push({ text: runtimeUptime(rt), width: SERVICE_UPTIME_COL, tone: "text" });
  }
  if (cols.rst) {
    cells.push({ text: String(restarts), width: STATS_RESTARTS_COL, tone: restarts > 0 ? "warning" : "muted" });
  }
  if (cols.pid) {
    cells.push({ text: rt?.pid ? String(rt.pid) : "—", width: SERVICE_PID_COL, tone: "muted" });
  }
  return (
    <box flexDirection="column" flexShrink={0} overflow="hidden">
      <TableRow palette={palette} gap={SERVICE_COL_GAP} stripe={stripe} cells={cells} />
      {rt?.last_error ? (
        <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
          <text fg={palette.error} wrapMode="none">
            {padClip(`  ${rt.last_error}`, Math.max(24, cols.name + SERVICE_COL_GAP + SERVICE_STATE_COL + SERVICE_HEALTH_COL))}
          </text>
        </box>
      ) : null}
    </box>
  );
}
