import { validate } from "../../config/index.ts";
import { type DevctlConfig } from "../../config/index.ts";
import { type GoogleStatus } from "../../google.ts";
import { EmptyState } from "../chrome.tsx";
import { useDensity } from "../density.tsx";
import { KeyHints, ScreenFrame } from "../layout.tsx";
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
  step?: number;
}) {
  const { palette, cfg, google, bootError, step = 0 } = props;
  const scale = useDensity();
  if (bootError && !cfg) {
    return (
      <EmptyState
        palette={palette}
        title="No configuration found"
        body="Would you like to run setup?"
        hint="[Enter] Setup   [Esc] Exit"
      />
    );
  }
  const issues = cfg ? validate(cfg) : ["configuration not loaded"];
  const rows = setupRows(cfg, google, issues);
  return (
    <ScreenFrame palette={palette} title="setup">
      <text fg={palette.primary}>Developer onboarding — 9 steps</text>
      {rows.map((row, index) => (
        <box
          key={row.name}
          height={scale.rowH}
          flexDirection="row"
          overflow="hidden"
          backgroundColor={index === step ? palette.highlight : undefined}
        >
          <box width={2} flexShrink={0}>
            <text fg={stateColor(palette, row.ok ? "OK" : "WARN")}>{stateGlyph(row.ok ? "OK" : "WARN")}</text>
          </box>
          <box width={22} flexShrink={0} overflow="hidden">
            <text fg={index === step ? palette.primary : palette.text}>{`${index + 1}. ${row.name}`}</text>
          </box>
          <box flexGrow={1} overflow="hidden">
            <text fg={index === step ? palette.text : palette.muted} wrapMode="none">
              {row.detail}
            </text>
          </box>
        </box>
      ))}
      {rows[step] && !rows[step].ok ? (
        <text fg={palette.warning} wrapMode="word">
          {`Selected: ${rows[step].detail}`}
        </text>
      ) : null}
      <text fg={palette.muted} wrapMode="word">
        Service accounts and IAP audiences stay in configuration. They are never hard-coded. Run `devctl setup` for the interactive CLI wizard.
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
  return [
    { name: STEPS[0], ok: Boolean(cfg?.repoRoot), detail: cfg?.repoRoot || "unknown" },
    { name: STEPS[1], ok: Boolean(cfg?.project.name), detail: cfg?.project.name || "set project.name" },
    { name: STEPS[2], ok: Boolean(cfg?.google.project_id || google?.projectID), detail: cfg?.google.project_id || google?.projectID || "optional for local-only" },
    { name: STEPS[3], ok: google?.adcAvailable === true, detail: google?.adcAvailable ? "ADC available" : "needed only for cloud identity / IAP" },
    { name: STEPS[4], ok: true, detail: "read from configuration; never hard-coded" },
    { name: STEPS[5], ok: !iap || (cfg?.proxy.routes ?? []).every((r) => r.auth.type.toLowerCase() !== "iap" || r.auth.audience !== ""), detail: iap ? "IAP routes present" : "no IAP routes" },
    { name: STEPS[6], ok: ports.length === 0 || Boolean(cfg), detail: `${ports.length} fixed ports from configuration` },
    { name: STEPS[7], ok: Object.keys(cfg?.profiles ?? {}).length > 0, detail: `${Object.keys(cfg?.profiles ?? {}).length} profile(s)` },
    { name: STEPS[8], ok: issues.length === 0, detail: issues.length === 0 ? "configuration is valid" : issues[0] ?? "invalid" },
  ];
}
