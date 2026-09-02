import { validate } from "../../config/index.ts";
import { type DevctlConfig } from "../../config/index.ts";
import { type GoogleStatus } from "../../google.ts";
import { EmptyState } from "../chrome.tsx";
import { useDensity } from "../density.tsx";
import { Chip, KeyHints, ScreenFrame } from "../layout.tsx";
import { googleProjectDisplay } from "../helpers.ts";
import { stateColor, stateGlyph, type Palette } from "../themes.ts";

const STEPS = [
  "Repository",
  "Environment",
  "Google project",
  "Authentication",
  "Service accounts",
  "IAP",
  "Ports",
  "Profiles",
  "Validation",
] as const;

export function SetupScreen(props: {
  palette: Palette;
  cfg?: DevctlConfig;
  google?: GoogleStatus;
  bootError?: string;
  bootErrorMissing?: boolean;
  step?: number;
}) {
  const { palette, cfg, google, bootError, bootErrorMissing = false, step = 0 } = props;
  const scale = useDensity();
  if (bootError && !cfg) {
    // A missing configuration is safe to offer setup for; an existing-but-
    // invalid one must show the real error instead — running setup here
    // would silently overwrite it rather than help fix it.
    return bootErrorMissing ? (
      <EmptyState
        palette={palette}
        title="No configuration found"
        body="Would you like to run setup?"
        hint="[Enter] Setup   [Esc] Exit"
      />
    ) : (
      <EmptyState
        palette={palette}
        title="Configuration error"
        body={bootError}
        hint="Fix .devctl/config.yaml, then restart devctl   [Esc] Exit"
      />
    );
  }
  const issues = cfg ? validate(cfg) : ["configuration not loaded"];
  const rows = setupRows(cfg, google, issues);
  const done = rows.filter((row) => row.ok).length;
  const total = rows.length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const barLen = 20;
  const filled = Math.round((percent / 100) * barLen);
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barLen - filled));
  const barColor = percent === 100 ? palette.success : percent === 0 ? palette.muted : palette.primary;
  const selected = rows[step];
  return (
    <ScreenFrame palette={palette} title="setup" scroll>
      <box flexDirection="row" overflow="hidden" flexShrink={0}>
        <text fg={palette.primary}>Developer onboarding</text>
      </box>
      <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
        <text wrapMode="none">
          <span fg={barColor}>{`[${bar}]`}</span>
          <span fg={palette.text}>{`  ${done}/${total} ready`}</span>
          <span fg={palette.muted}>{`  (${percent}%)`}</span>
        </text>
      </box>
      <box height={1} flexShrink={0} />
      {rows.map((row, index) => {
        const isSelected = index === step;
        return (
          <box
            key={row.name}
            height={scale.rowH}
            flexDirection="row"
            overflow="hidden"
            backgroundColor={isSelected ? palette.highlight : undefined}
            paddingLeft={1}
          >
            <box width={2} flexShrink={0}>
              <text fg={stateColor(palette, row.ok ? "OK" : "WARN")}>{stateGlyph(row.ok ? "OK" : "WARN")}</text>
            </box>
            <box width={3} flexShrink={0}>
              <text fg={isSelected ? palette.primary : palette.muted}>{String(index + 1).padStart(2, " ")}</text>
            </box>
            <box width={20} flexShrink={0} overflow="hidden">
              <text fg={isSelected ? palette.primary : palette.text}>{row.name}</text>
            </box>
            <box flexGrow={1} overflow="hidden">
              <text fg={isSelected ? palette.text : palette.muted} wrapMode="none">
                {row.detail}
              </text>
            </box>
          </box>
        );
      })}
      <box height={1} flexShrink={0} />
      {selected ? (
        <box
          border
          borderStyle="rounded"
          borderColor={selected.ok ? palette.success : palette.warning}
          title={selected.name}
          titleColor={selected.ok ? palette.success : palette.warning}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          flexShrink={0}
          overflow="hidden"
        >
          <text fg={selected.ok ? palette.text : palette.warning} wrapMode="word">
            {selected.detail}
          </text>
        </box>
      ) : null}
      <box height={1} flexShrink={0} />
      <box flexDirection="row" overflow="hidden" flexShrink={0}>
        <Chip palette={palette} label="never hard-coded" tone="idle" />
      </box>
      <text fg={palette.muted} wrapMode="word">
        Service accounts and IAP audiences stay in configuration. Run `devctl setup` for the interactive CLI wizard.
      </text>
      <KeyHints
        palette={palette}
        hints={[
          { key: "j/k", label: "steps" },
          { key: "enter", label: cfg ? "start" : "begin setup" },
          { key: "esc", label: "exit" },
          { key: "o", label: "profiles" },
        ]}
      />
    </ScreenFrame>
  );
}

function setupRows(
  cfg?: DevctlConfig,
  google?: GoogleStatus,
  issues: string[] = [],
): Array<{ name: string; ok: boolean; detail: string }> {
  const ports = Object.values(cfg?.services ?? {}).flatMap((svc) => svc.ports.filter((p) => !p.auto));
  const iap = (cfg?.proxy.routes ?? []).some((route) => route.auth.type.toLowerCase() === "iap");
  const googleProject = googleProjectDisplay(cfg, undefined, google).project;
  return [
    { name: STEPS[0], ok: Boolean(cfg?.repoRoot), detail: cfg?.repoRoot || "unknown" },
    { name: STEPS[1], ok: Boolean(cfg?.project.name), detail: cfg?.project.name || "set project.name" },
    { name: STEPS[2], ok: Boolean(googleProject), detail: googleProject || "optional for local-only" },
    { name: STEPS[3], ok: google?.adcAvailable === true, detail: google?.adcAvailable ? "ADC available" : "needed only for cloud identity / IAP" },
    { name: STEPS[4], ok: true, detail: "read from configuration; never hard-coded" },
    { name: STEPS[5], ok: !iap || (cfg?.proxy.routes ?? []).every((r) => r.auth.type.toLowerCase() !== "iap" || r.auth.audience !== ""), detail: iap ? "IAP routes present" : "no IAP routes" },
    { name: STEPS[6], ok: ports.length === 0 || Boolean(cfg), detail: `${ports.length} fixed ports from configuration` },
    { name: STEPS[7], ok: Object.keys(cfg?.profiles ?? {}).length > 0, detail: `${Object.keys(cfg?.profiles ?? {}).length} profile(s)` },
    { name: STEPS[8], ok: issues.length === 0, detail: issues.length === 0 ? "configuration is valid" : issues[0] ?? "invalid" },
  ];
}
