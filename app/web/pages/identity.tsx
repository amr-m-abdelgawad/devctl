import { Empty } from "../components/primitives.tsx";
import { StatusBadge } from "../components/status.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { hrefFor } from "../hash.ts";
import type { ServiceAccountStatus, StatusSummary } from "../types.ts";

export function IdentityPage(props: { status?: StatusSummary }) {
  const identity = props.status?.identity;
  if (!identity) {
    return <Empty>Waiting for status…</Empty>;
  }
  const accounts = serviceAccountRows(identity.service_account_status ?? {}, identity.service_accounts ?? {});
  const impersonation = impersonationLabel(accounts);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Google identity</CardTitle>
          <Badge variant={identity.adc ? "success" : "warning"}>{identity.adc ? "ADC available" : "ADC missing"}</Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0 text-sm">
          <Field label="user" value={identity.user || "(unknown)"} />
          <Field label="project" value={identity.project || "(unset)"} />
          <Field label="source" value={identity.project_source || "—"} />
          <Field label="ADC" value={identity.adc ? "available" : "missing"} />
          <Field label="IAP" value={identity.iap ? "routes present" : "no IAP routes"} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Service accounts</CardTitle>
          <Badge variant="muted">{accounts.length}</Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0">
          {accounts.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">None configured — identities come from config, never hard-coded.</p>
          ) : (
            accounts.map((row) => (
              <div key={row.email} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 px-2.5 py-1.5">
                <span className="font-mono text-[12px]">{row.email}</span>
                <StatusBadge value={row.status} />
              </div>
            ))
          )}
          <p className="text-[12px] text-muted-foreground">Impersonation: {impersonation}</p>
        </CardContent>
      </Card>

      {identity.adc ? null : (
        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-[13px] text-muted-foreground">
            <p>Local services still start. Cloud identity, impersonation, and IAP need Application Default Credentials.</p>
            <p className="mt-2 font-mono text-[12px] text-foreground">devctl auth login</p>
            <p className="mt-1 font-mono text-[12px] text-foreground">TUI /auth login</p>
            <p className="mt-2">
              Interactive login stays CLI/TUI-only. After ADC is available, <a className="text-primary underline-offset-4 hover:underline" href={hrefFor("doctor")}>Doctor</a> can re-check impersonation.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Field(props: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/40 py-1.5 last:border-b-0">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{props.label}</span>
      <span className="font-mono text-[12px]">{props.value}</span>
    </div>
  );
}

function serviceAccountRows(
  statuses: Record<string, ServiceAccountStatus>,
  booleans: Record<string, boolean>,
): Array<{ email: string; status: ServiceAccountStatus }> {
  const emails = new Set([...Object.keys(statuses), ...Object.keys(booleans)]);
  return [...emails]
    .sort((a, b) => a.localeCompare(b))
    .map((email) => ({
      email,
      status: statuses[email] ?? (booleans[email] ? "available" : "unknown"),
    }));
}

function impersonationLabel(rows: Array<{ status: ServiceAccountStatus }>): string {
  if (rows.length === 0) {
    return "not configured";
  }
  if (rows.some((row) => row.status === "available")) {
    return "available";
  }
  if (rows.some((row) => row.status === "unavailable")) {
    return "unavailable";
  }
  return "not probed";
}
