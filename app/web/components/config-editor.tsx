import { useEffect, useState } from "react";
import { fetchConfigDocument } from "../api.ts";
import type { ConfigDocument, ConfigSaveResult } from "../../src/ports/web-host.ts";
import { useOperatorAction } from "../operator.ts";
import type { RunControl } from "../control.ts";
import { Button } from "./ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";
import { Input } from "./ui/input.tsx";
import { ConfirmAction } from "./confirm-action.tsx";
import { ChoiceGroup } from "./filters.tsx";
import { Badge } from "./ui/badge.tsx";

export function ConfigEditor(props: { active: boolean; onControl: RunControl }) {
  const [document, setDocument] = useState<ConfigDocument>();
  const [draft, setDraft] = useState("");
  const [validated, setValidated] = useState<string>();
  const [issues, setIssues] = useState<string[]>([]);
  const [loadError, setLoadError] = useState("");
  const [result, setResult] = useState<ConfigSaveResult>();
  const [mode, setMode] = useState("edit");
  const [compose, setCompose] = useState("");
  const [importNotes, setImportNotes] = useState<string[]>([]);
  const [starter, setStarter] = useState({ name: "", project: "", profile: "", sa: "", audience: "", proxyPort: "18800" });
  const { run, pending, error } = useOperatorAction();
  const dirty = document !== undefined && draft !== document.text;
  const load = async (): Promise<void> => {
    try {
      const next = await fetchConfigDocument();
      setDocument(next);
      setDraft(next.text);
      setValidated(undefined);
      setIssues([]);
      setLoadError("");
      setResult(undefined);
      setImportNotes([]);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : "Unable to read configuration");
    }
  };
  useEffect(() => {
    if (props.active && !document) void load();
  }, [props.active]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  const validate = async (): Promise<void> => {
    const text = draft;
    const next = await run<{ issues: string[] }>("config_validate", { text });
    if (next) {
      setIssues(next.issues);
      setValidated(next.issues.length ? undefined : text);
      setResult(undefined);
    }
  };
  const save = async (): Promise<void> => {
    if (!document) return;
    const next = await run<ConfigSaveResult>("config_save", { text: draft, revision: document.revision, confirm: true });
    if (next) {
      setResult(next);
      setIssues(next.issues);
      if (next.saved && next.document) setDocument(next.document);
    }
  };
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Configuration editor</CardTitle>
          {dirty ? <Badge variant="warning">Unsaved draft</Badge> : null}
          {validated === draft ? <Badge variant="success">Validated</Badge> : null}
        </div>
        <ChoiceGroup
          label="Editor view"
          value={mode}
          onChange={setMode}
          options={[
            { value: "edit", label: "Edit" },
            { value: "compare", label: "Compare" },
            { value: "import", label: "Import / setup" },
          ]}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="break-all font-mono text-xs text-muted-foreground">{document?.path || "Loading the active configuration file…"}</p>
        <p className="text-xs text-muted-foreground">
          Edits preserve the file’s comments and formatting. Validate the draft before saving. Your draft stays here when you navigate to
          another page.
        </p>
        {loadError || error ? (
          <p role="alert" className="text-sm text-destructive">
            {loadError || error}
          </p>
        ) : null}
        {mode === "import" ? (
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  { key: "name", label: "Environment name", placeholder: "Use the repository name" },
                  { key: "project", label: "Google Cloud project", placeholder: "Optional project ID" },
                  { key: "profile", label: "Default profile", placeholder: "Optional profile name" },
                  { key: "sa", label: "Service account", placeholder: "Optional service account email" },
                  { key: "audience", label: "IAP audience", placeholder: "Optional audience URL" },
                  { key: "proxyPort", label: "Proxy port", placeholder: "18800" },
                ] as const
              ).map((field) => (
                <label key={field.key} className="flex min-w-0 flex-col gap-2 text-xs">
                  {field.label}
                  <Input
                    value={starter[field.key]}
                    placeholder={field.placeholder}
                    inputMode={field.key === "proxyPort" ? "numeric" : undefined}
                    onChange={(event) => setStarter({ ...starter, [field.key]: event.currentTarget.value })}
                  />
                </label>
              ))}
            </div>
            <Button
              variant="outline"
              disabled={!document || Boolean(pending)}
              onClick={() => {
                const args = Object.fromEntries(Object.entries(starter).filter(([, value]) => value.trim() !== ""));
                void run<{ text: string }>("config_starter", { ...args, proxyPort: Number(starter.proxyPort) }).then((next) => {
                  if (next) {
                    setDraft(next.text);
                    setMode("edit");
                    setValidated(undefined);
                  }
                });
              }}
            >
              Create starter draft
            </Button>
            <label className="flex flex-col gap-2 text-xs">
              Paste Docker Compose YAML
              <textarea
                className="code-editor"
                value={compose}
                onChange={(event) => setCompose(event.currentTarget.value)}
                placeholder="services:…"
                spellCheck={false}
              />
            </label>
            <Button
              variant="outline"
              disabled={!document || Boolean(pending) || !compose.trim()}
              onClick={() => {
                void run<{ yaml: string; dropped: Array<{ service: string; field: string; reason: string }> }>("config_import", {
                  text: compose,
                }).then((next) => {
                  if (next) {
                    setDraft(next.yaml);
                    setImportNotes(next.dropped.map((row) => `${row.service}.${row.field}: ${row.reason}`));
                    setMode("edit");
                    setValidated(undefined);
                  }
                });
              }}
            >
              Import as draft
            </Button>
          </div>
        ) : mode === "compare" ? (
          <div className="config-compare">
            <section>
              <h3>On disk</h3>
              <pre>{document?.text || "Empty file"}</pre>
            </section>
            <section>
              <h3>Your draft</h3>
              <pre>{draft || "Empty draft"}</pre>
            </section>
          </div>
        ) : (
          <label className="flex flex-col gap-2 text-xs">
            Configuration YAML
            <textarea
              className="code-editor"
              value={draft}
              disabled={!document}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                setResult(undefined);
              }}
              spellCheck={false}
              aria-invalid={issues.length > 0}
            />
          </label>
        )}
        {importNotes.length ? (
          <details>
            <summary className="text-xs text-warning">Import dropped {importNotes.length} unsupported fields</summary>
            <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
              {importNotes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {issues.length ? (
          <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
            <p className="mb-2 font-semibold">Configuration was not saved</p>
            <ul className="flex flex-col gap-1">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {result?.saved ? (
          <div role="status" className="rounded-lg bg-primary/10 p-3 text-xs">
            <p>{result.reload_error ? `Saved to disk; reload failed: ${result.reload_error}` : "Configuration saved and reloaded."}</p>
            {result.reload?.restart_required.length ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span>Restart required: {result.reload.restart_required.join(", ")}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    props.onControl("restart_services", { services: result.reload?.restart_required }, "Restarting changed services…")
                  }
                >
                  Restart changed services
                </Button>
              </div>
            ) : null}
            {result.reload?.supervisor_restart_required?.length ? (
              <p className="mt-2 text-warning">Restart the supervisor to apply: {result.reload.supervisor_restart_required.join(", ")}</p>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={!document || Boolean(pending)} onClick={() => void validate()}>
            {pending === "config_validate" ? "Validating…" : "Validate draft"}
          </Button>
          <ConfirmAction
            label="Save & reload"
            title="Save this configuration?"
            description={
              <span>
                Write the validated draft to <code>{document?.path}</code> and reload the supervisor. Services that need a restart will be
                listed afterward.
              </span>
            }
            disabled={!document || Boolean(pending) || !dirty || validated !== draft}
            onConfirm={save}
          />
          <ConfirmAction
            label="Reload from disk"
            title="Reload the configuration file?"
            description="This replaces your current draft with the file on disk."
            disabled={Boolean(pending)}
            onConfirm={load}
          />
          <span className="text-[11px] text-muted-foreground">
            {validated !== draft ? "Validate to enable saving." : "Draft is ready to save."}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
