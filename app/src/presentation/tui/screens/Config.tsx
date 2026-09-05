import { type ReactNode, type Ref } from "react";
import { type ScrollBoxRenderable } from "@opentui/core";
import { EmptyState } from "../chrome.tsx";
import {
  CONFIG_FACT_LABEL,
  CONFIG_TWO_COL_MIN,
  configExtraFacts,
  configGoogleFacts,
  configHeaderChips,
  configLogFacts,
  configProfileRows,
  configProjectFacts,
  configProxyFacts,
  configRouteRows,
  configRuntimeFacts,
  configServiceNameWidth,
  configServiceRows,
  configTaskRows,
  configTemplateRows,
  type ConfigFact,
  type ConfigNamedSummary,
  type ConfigProfileRow,
  type ConfigRouteRow,
  type ConfigServiceRow,
} from "../config-view.ts";
import { useDensity } from "../density.tsx";
import { clipText, padClip } from "../helpers.ts";
import { KeyHints, MetaBar, ScreenFrame, scrollboxStyle, Toolbar } from "../layout.tsx";
import { serviceColor, type Palette } from "../themes.ts";
import { type DevctlConfig } from "../../../adapters/config/index.ts";
import { VERSION } from "../../../version.ts";

const COL_GAP = 1;
const ROW_GAP = 1;

export function ConfigScreen(props: { palette: Palette; cfg?: DevctlConfig; width: number; scrollRef?: Ref<ScrollBoxRenderable> }) {
  const { palette, cfg, width } = props;
  const scale = useDensity();
  if (!cfg) {
    return <EmptyState palette={palette} title="No configuration" body="Create .devctl/config.yaml or run setup." />;
  }
  const inner = Math.max(CONFIG_FACT_LABEL + 8, width - 6 - scale.pad * 2);
  const wide = inner >= CONFIG_TWO_COL_MIN;
  const colWidth = wide ? Math.floor((inner - COL_GAP) / 2) : inner;
  const services = configServiceRows(cfg);
  const routes = configRouteRows(cfg);
  const profiles = configProfileRows(cfg);
  const templates = configTemplateRows(cfg);
  const tasks = configTaskRows(cfg);
  return (
    <ScreenFrame palette={palette} title={`config  ${cfg.project.name || "unnamed"}`}>
      <MetaBar palette={palette} items={configHeaderChips(cfg)} />
      <box flexGrow={1} overflow="hidden">
        <scrollbox
          ref={props.scrollRef}
          focused={false}
          stickyScroll={false}
          scrollX={false}
          style={scrollboxStyle(palette)}
        >
          <box flexDirection="column" overflow="hidden" gap={ROW_GAP}>
            <ColumnPair
              wide={wide}
              left={
                <Section palette={palette} title="project">
                  <FactList palette={palette} facts={configProjectFacts(cfg, VERSION)} width={colWidth} />
                </Section>
              }
              right={
                <Section palette={palette} title="google">
                  <FactList palette={palette} facts={configGoogleFacts(cfg)} width={colWidth} />
                </Section>
              }
            />
            <ColumnPair
              wide={wide}
              left={
                <Section palette={palette} title="runtime">
                  <FactList palette={palette} facts={configRuntimeFacts(cfg)} width={colWidth} />
                </Section>
              }
              right={
                <Section palette={palette} title="logs">
                  <FactList palette={palette} facts={configLogFacts(cfg)} width={colWidth} />
                </Section>
              }
            />
            <Section palette={palette} title={`proxy  ${cfg.proxy.enabled ? "enabled" : "disabled"}`}>
              <FactList palette={palette} facts={configProxyFacts(cfg)} width={inner} />
              <RouteList palette={palette} routes={routes} width={inner} />
            </Section>
            <Section palette={palette} title={`services  ${services.length}`}>
              <ServiceList palette={palette} rows={services} width={inner} />
            </Section>
            <Section palette={palette} title={`tasks  ${tasks.length}`}>
              <SummaryList palette={palette} rows={tasks} empty="no tasks" width={inner} />
            </Section>
            <ColumnPair
              wide={wide}
              left={
                <Section palette={palette} title={`profiles  ${profiles.length}`}>
                  <ProfileList palette={palette} rows={profiles} width={colWidth} />
                </Section>
              }
              right={
                <Section palette={palette} title={`templates  ${templates.length}`}>
                  <SummaryList palette={palette} rows={templates} empty="no templates" width={colWidth} />
                </Section>
              }
            />
            <Section palette={palette} title="extras">
              <FactList palette={palette} facts={configExtraFacts(cfg)} width={inner} />
            </Section>
          </box>
        </scrollbox>
      </box>
      <Toolbar palette={palette} backgroundColor={palette.element} edge="top">
        <KeyHints
          palette={palette}
          hints={[
            { key: "v", label: "validate/save buffer" },
            { key: "e", label: "open in $EDITOR" },
            { key: "/diff", label: "config sources" },
            { key: "/reload", label: "re-read .devctl after editing" },
            { key: "j/k", label: "scroll" },
          ]}
        />
      </Toolbar>
    </ScreenFrame>
  );
}

function ColumnPair(props: { wide: boolean; left: ReactNode; right: ReactNode }) {
  const { wide, left, right } = props;
  if (!wide) {
    return (
      <box flexDirection="column" overflow="hidden" gap={ROW_GAP} flexShrink={0}>
        {left}
        {right}
      </box>
    );
  }
  return (
    <box flexDirection="row" overflow="hidden" gap={COL_GAP} flexShrink={0}>
      <box flexGrow={1} flexBasis={0} overflow="hidden">
        {left}
      </box>
      <box flexGrow={1} flexBasis={0} overflow="hidden">
        {right}
      </box>
    </box>
  );
}

function Section(props: { palette: Palette; title: string; children?: ReactNode }) {
  const { palette, title, children } = props;
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={palette.border}
      title={title}
      titleColor={palette.accent}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      overflow="hidden"
      flexShrink={0}
    >
      {children}
    </box>
  );
}

function FactList(props: { palette: Palette; facts: readonly ConfigFact[]; width: number }) {
  const { palette, facts, width } = props;
  const valueWidth = Math.max(4, width - CONFIG_FACT_LABEL - 4);
  return (
    <box flexDirection="column" overflow="hidden" flexShrink={0}>
      {facts.map((fact) => (
        <box key={fact.label} height={1} flexDirection="row" overflow="hidden">
          <box width={CONFIG_FACT_LABEL} flexShrink={0} overflow="hidden">
            <text fg={palette.muted} wrapMode="none">
              {padClip(fact.label, CONFIG_FACT_LABEL)}
            </text>
          </box>
          <box width={valueWidth} flexShrink={0} overflow="hidden">
            <text fg={factTone(palette, fact.tone)} wrapMode="none">
              {padClip(fact.value, valueWidth)}
            </text>
          </box>
        </box>
      ))}
    </box>
  );
}

function ServiceList(props: { palette: Palette; rows: readonly ConfigServiceRow[]; width: number }) {
  const { palette, rows, width } = props;
  if (rows.length === 0) {
    return <Muted palette={palette} text="no services" />;
  }
  const nameWidth = configServiceNameWidth(rows);
  const restWidth = Math.max(8, width - nameWidth - 6);
  return (
    <box flexDirection="column" overflow="hidden" flexShrink={0}>
      {rows.map((row) => (
        <box key={row.name} height={1} flexDirection="row" overflow="hidden">
          <box width={nameWidth} flexShrink={0} overflow="hidden">
            <text fg={serviceColor(row.name, palette)} wrapMode="none">
              {padClip(row.name, nameWidth)}
            </text>
          </box>
          <box width={restWidth} flexShrink={0} overflow="hidden">
            <text fg={palette.text} wrapMode="none">
              {clipText(serviceLine(row), restWidth)}
            </text>
          </box>
        </box>
      ))}
    </box>
  );
}

function RouteList(props: { palette: Palette; routes: readonly ConfigRouteRow[]; width: number }) {
  const { palette, routes, width } = props;
  if (routes.length === 0) {
    return <Muted palette={palette} text="no routes" />;
  }
  const nameWidth = Math.min(CONFIG_FACT_LABEL + 4, Math.max(8, ...routes.map((row) => row.name.length)));
  const restWidth = Math.max(8, width - nameWidth - 6);
  return (
    <box flexDirection="column" overflow="hidden" flexShrink={0}>
      {routes.map((row) => (
        <box key={`${row.name}-${row.match}`} height={1} flexDirection="row" overflow="hidden">
          <box width={nameWidth} flexShrink={0} overflow="hidden">
            <text fg={palette.primary} wrapMode="none">
              {padClip(row.name, nameWidth)}
            </text>
          </box>
          <box width={restWidth} flexShrink={0} overflow="hidden">
            <text fg={palette.text} wrapMode="none">
              {clipText(routeLine(row), restWidth)}
            </text>
          </box>
        </box>
      ))}
    </box>
  );
}

function ProfileList(props: { palette: Palette; rows: readonly ConfigProfileRow[]; width: number }) {
  const { palette, rows, width } = props;
  if (rows.length === 0) {
    return <Muted palette={palette} text="no profiles" />;
  }
  const nameWidth = Math.min(12, Math.max(8, ...rows.map((row) => row.name.length)));
  const restWidth = Math.max(8, width - nameWidth - 6);
  return (
    <box flexDirection="column" overflow="hidden" flexShrink={0}>
      {rows.map((row) => (
        <box key={row.name} height={1} flexDirection="row" overflow="hidden">
          <box width={nameWidth} flexShrink={0} overflow="hidden">
            <text fg={palette.primary} wrapMode="none">
              {padClip(row.name, nameWidth)}
            </text>
          </box>
          <box width={restWidth} flexShrink={0} overflow="hidden">
            <text fg={palette.text} wrapMode="none">
              {clipText(row.env === "—" ? row.services : `${row.services}  env ${row.env}`, restWidth)}
            </text>
          </box>
        </box>
      ))}
    </box>
  );
}

function SummaryList(props: { palette: Palette; rows: readonly ConfigNamedSummary[]; empty: string; width: number }) {
  const { palette, rows, empty, width } = props;
  if (rows.length === 0) {
    return <Muted palette={palette} text={empty} />;
  }
  const nameWidth = Math.min(14, Math.max(8, ...rows.map((row) => row.name.length)));
  const restWidth = Math.max(8, width - nameWidth - 6);
  return (
    <box flexDirection="column" overflow="hidden" flexShrink={0}>
      {rows.map((row) => (
        <box key={row.name} height={1} flexDirection="row" overflow="hidden">
          <box width={nameWidth} flexShrink={0} overflow="hidden">
            <text fg={palette.text} wrapMode="none">
              {padClip(row.name, nameWidth)}
            </text>
          </box>
          <box width={restWidth} flexShrink={0} overflow="hidden">
            <text fg={palette.muted} wrapMode="none">
              {clipText(row.summary, restWidth)}
            </text>
          </box>
        </box>
      ))}
    </box>
  );
}

function Muted(props: { palette: Palette; text: string }) {
  return (
    <box height={1} overflow="hidden">
      <text fg={props.palette.muted} wrapMode="none">
        {props.text}
      </text>
    </box>
  );
}

function serviceLine(row: ConfigServiceRow): string {
  const extend = row.extends === "—" ? "" : `  ${row.extends}`;
  return `  ${row.ports}  ${row.identity}  ${row.health}  ${row.restart}  ← ${row.depends}${extend}`;
}

function routeLine(row: ConfigRouteRow): string {
  return `  ${row.auth}  ${row.identity}  ${row.match} → ${row.upstream}`;
}

function factTone(palette: Palette, tone: ConfigFact["tone"]): string {
  if (tone === "success") {
    return palette.success;
  }
  if (tone === "warning") {
    return palette.warning;
  }
  if (tone === "error") {
    return palette.error;
  }
  if (tone === "muted") {
    return palette.muted;
  }
  return palette.text;
}
