import { LoadingState } from "../chrome.tsx";
import { Banner, FieldRow, ScreenFrame } from "../layout.tsx";
import { type Palette } from "../themes.ts";
import { type DevctlConfig, isServiceAccountIdentity } from "../../config/index.ts";
import { type GoogleStatus } from "../../google.ts";
import { type IdentitySnapshot } from "../../types.ts";

export function AuthScreen(props: { palette: Palette; cfg?: DevctlConfig; google?: GoogleStatus; identity?: IdentitySnapshot }) {
  const { palette, cfg, google, identity } = props;
  if (!google && !identity) {
    return <LoadingState palette={palette} label="Checking Application Default Credentials…" />;
  }
  const accounts = serviceAccountRows(cfg, identity);
  const user = identity?.user || google?.userEmail || "";
  const project = identity?.project || google?.projectID || cfg?.google.project_id || "";
  const source = identity?.project_source || google?.projectSource || "";
  const adc = identity?.adc ?? google?.adcAvailable === true;
  const iap = identity?.iap ?? (cfg?.proxy.routes ?? []).some((r) => r.auth.type.toLowerCase() === "iap");
  return (
    <ScreenFrame palette={palette} title="identity" scroll>
      <FieldRow palette={palette} label="user" value={user || "(unknown)"} />
      <FieldRow palette={palette} label="project" value={project || "(unset)"} />
      <FieldRow palette={palette} label="source" value={source || "—"} />
      <FieldRow palette={palette} label="ADC" value={adc ? "✓ available" : "✗ missing"} tone={adc ? "success" : "error"} />
      <FieldRow palette={palette} label="gcloud" value={google?.gcloudInstalled ? "✓ installed" : "✗ not installed"} tone={google?.gcloudInstalled ? "success" : "error"} />
      <text fg={palette.primary}>Service accounts</text>
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
      <FieldRow
        palette={palette}
        label="impersonation"
        value={accounts.some((row) => row.ok === true) ? "AVAILABLE" : accounts.length > 0 ? "UNAVAILABLE" : "not configured"}
      />
      <FieldRow palette={palette} label="IAP" value={iap ? "routes present (audience required per route)" : "no IAP routes"} />
      {!adc ? (
        <Banner
          palette={palette}
          title="ADC unavailable"
          body="Local services still start. Cloud identity, impersonation, and IAP need ADC."
          hint="run  gcloud auth application-default login   or  /auth"
        />
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
