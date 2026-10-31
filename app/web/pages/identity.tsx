import { useState } from "react";
import { AuthControls } from "../components/auth-controls.tsx";
import { CredentialActivity } from "../components/credential-activity.tsx";
import { ChoiceGroup, SearchInput } from "../components/filters.tsx";
import { Empty } from "../components/primitives.tsx";
import { StatusBadge } from "../components/status.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import type { ServiceAccountStatus, StatusSummary } from "../types.ts";

export function IdentityPage(props: { status?: StatusSummary }) {
  const [tab, setTab] = useState("identity");
  const [search, setSearch] = useState("");
  const identity = props.status?.identity;
  if (!identity) {
    return <Empty>Waiting for status…</Empty>;
  }
  const accounts = serviceAccountRows(identity.service_account_status ?? {}, identity.service_accounts ?? {});
  const impersonation = impersonationLabel(accounts);
  return (
    <div className="flex flex-col gap-5">
      <div className="max-w-full overflow-x-auto">
        <ChoiceGroup
          label="Identity view"
          value={tab}
          onChange={setTab}
          options={[
            { value: "identity", label: "Identity & sign-in" },
            { value: "credentials", label: "Credentials" },
            { value: "activity", label: "Token activity" },
          ]}
        />
      </div>
      {tab === "activity" ? (
        <CredentialActivity />
      ) : tab === "credentials" ? (
        <Card>
          <CardHeader>
            <CardTitle>Credential store · {props.status?.credentials?.backend || "unavailable"}</CardTitle>
            <SearchInput
              label="Find identity or audience"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              className="w-full sm:w-72"
            />
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-xs text-muted-foreground">
              Credential values are never shown. This view lists cached identities, audiences, and expiry times.
            </p>
            <div className="credential-events">
              {props.status?.credentials?.entries
                .filter((entry) => `${entry.identity} ${entry.audience}`.toLowerCase().includes(search.toLowerCase()))
                .map((entry) => (
                  <div key={`${entry.identity}:${entry.audience}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="break-all font-mono text-xs">{entry.identity}</p>
                      <Badge variant={entry.valid ? "success" : "warning"}>{entry.valid ? "Valid" : "Expired"}</Badge>
                    </div>
                    <p className="break-all text-xs text-muted-foreground">{entry.audience || "No audience"}</p>
                    <p className="text-xs text-muted-foreground">Expires: {new Date(entry.expires_at).toLocaleString()}</p>
                  </div>
                ))}
            </div>
            {!props.status?.credentials?.entries.length ? <Empty>No cached credentials.</Empty> : null}
          </CardContent>
        </Card>
      ) : (
        <>
          <AuthControls />
          <div className="identity-layout">
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
                  <p className="text-[13px] text-muted-foreground">None configured — identities come from config, never hard-coded.</p>
                ) : (
                  accounts.map((row) => (
                    <div
                      key={row.email}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 px-2.5 py-1.5"
                    >
                      <span className="break-all font-mono text-[13px]">{row.email}</span>
                      <StatusBadge value={row.status} />
                    </div>
                  ))
                )}
                <p className="text-[13px] text-muted-foreground">Impersonation: {impersonation}</p>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function Field(props: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/40 py-1.5 last:border-b-0">
      <span className="text-[12px] uppercase tracking-wide text-muted-foreground">{props.label}</span>
      <span className="break-all font-mono text-[13px]">{props.value}</span>
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
