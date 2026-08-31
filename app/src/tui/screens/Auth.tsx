import { type ReactNode } from "react";
import { LoadingState } from "../chrome.tsx";
import { googleProjectDisplay } from "../helpers.ts";
import { Chip, FieldRow, ScreenFrame } from "../layout.tsx";
import { type Palette } from "../themes.ts";
import { type DevctlConfig, isServiceAccountIdentity } from "../../config/index.ts";
import { type GoogleStatus } from "../../google.ts";
import { type IdentitySnapshot } from "../../types.ts";

function Section(props: { palette: Palette; title: string; tone?: "success" | "warning" | "error" | "muted"; children: ReactNode }) {
  const { palette, title, tone = "muted", children } = props;
  const borderColor = tone === "success" ? palette.success : tone === "warning" ? palette.warning : tone === "error" ? palette.error : palette.border;
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

export function AuthScreen(props: { palette: Palette; cfg?: DevctlConfig; google?: GoogleStatus; identity?: IdentitySnapshot }) {
  const { palette, cfg, google, identity } = props;
  if (!google && !identity) {
    return <LoadingState palette={palette} label="Checking Application Default Credentials…" />;
  }
  const accounts = serviceAccountRows(cfg, identity);
  const user = identity?.user || google?.userEmail || "";
  const { project, source } = googleProjectDisplay(cfg, identity, google);
  const adc = identity?.adc ?? google?.adcAvailable === true;
  const iap = identity?.iap ?? (cfg?.proxy.routes ?? []).some((r) => r.auth.type.toLowerCase() === "iap");
  const impersonationAvailable = accounts.some((row) => row.ok === true);

  return (
    <ScreenFrame palette={palette} title="identity" scroll>
      <Section palette={palette} title="Google identity" tone={adc ? "success" : "warning"}>
        <FieldRow palette={palette} label="user" value={user || "(unknown)"} />
        <FieldRow palette={palette} label="project" value={project || "(unset)"} />
        <FieldRow palette={palette} label="source" value={source || "—"} />
        <FieldRow palette={palette} label="ADC" value={adc ? "✓ available" : "✗ missing"} tone={adc ? "success" : "error"} />
        <FieldRow
          palette={palette}
          label="gcloud"
          value={google?.gcloudInstalled ? "✓ installed" : "✗ not installed"}
          tone={google?.gcloudInstalled ? "success" : "error"}
        />
      </Section>

      <Section
        palette={palette}
        title={`Service accounts (${accounts.length})`}
        tone={accounts.length === 0 ? "muted" : impersonationAvailable ? "success" : "warning"}
      >
        {accounts.length === 0 ? (
          <text fg={palette.muted} wrapMode="word">
            none configured — identities come from config, never hard-coded
          </text>
        ) : (
          accounts.map((row) => (
            <text key={row.email} fg={row.ok === true ? palette.success : row.ok === false ? palette.error : palette.text} wrapMode="none">
              {`${row.ok === true ? "✓" : row.ok === false ? "✗" : "○"} ${row.email}`}
            </text>
          ))
        )}
        <box height={1} flexShrink={0} />
        <FieldRow
          palette={palette}
          label="impersonation"
          value={impersonationAvailable ? "AVAILABLE" : accounts.length > 0 ? "UNAVAILABLE" : "not configured"}
          tone={impersonationAvailable ? "success" : accounts.length > 0 ? "warning" : "muted"}
        />
      </Section>

      <Section palette={palette} title="IAP" tone={iap ? "success" : "muted"}>
        <box flexDirection="row" overflow="hidden" flexShrink={0}>
          <Chip palette={palette} label={iap ? "routes present" : "no IAP routes"} tone={iap ? "success" : "idle"} />
        </box>
        {iap ? (
          <text fg={palette.muted} wrapMode="word">
            each route needs its own audience
          </text>
        ) : null}
      </Section>

      {!adc ? (
        <Section palette={palette} title="ADC unavailable" tone="warning">
          <text fg={palette.text} wrapMode="word">
            Local services still start. Cloud identity, impersonation, and IAP need ADC.
          </text>
          <text fg={palette.muted} wrapMode="word">
            run `gcloud auth application-default login`   or  /auth
          </text>
        </Section>
      ) : null}
    </ScreenFrame>
  );
}

function serviceAccountRows(cfg?: DevctlConfig, identity?: IdentitySnapshot): { email: string; ok?: boolean }[] {
  if (identity && Object.keys(identity.service_accounts).length > 0) {
    return Object.entries(identity.service_accounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([email, ok]) => ({ email, ok }));
  }
  const seen = new Set<string>();
  const rows: { email: string; ok?: boolean }[] = [];
  for (const svc of Object.values(cfg?.services ?? {})) {
    if (isServiceAccountIdentity(svc.identity)) {
      const sa = svc.identity.service_account;
      if (sa !== "" && !seen.has(sa)) {
        seen.add(sa);
        rows.push({ email: sa });
      }
    }
  }
  return rows;
}
