import { useCallback, useEffect, useState, type ReactNode } from "react";
import { fetchPreferences, postControl } from "../api.ts";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { cn } from "../lib/utils.ts";
import type { ControlArgs, PreferenceLayer, PreferenceSnapshot, StatusSummary } from "../types.ts";

const INSPECT_CAP_1_MIB = 1_048_576;
const INSPECT_CAP_OPTIONS = [
  { id: String(INSPECT_CAP_1_MIB), label: "1 MiB" },
  { id: String(4 * INSPECT_CAP_1_MIB), label: "4 MiB" },
  { id: String(8 * INSPECT_CAP_1_MIB), label: "8 MiB" },
  { id: String(16 * INSPECT_CAP_1_MIB), label: "16 MiB" },
];

function applyAppearance(value: "dark" | "light"): void {
  document.documentElement.dataset.appearance = value;
}

function layerLabel(layer: PreferenceLayer | undefined): string | undefined {
  if (layer === "repo") {
    return "this repo";
  }
  if (layer === "user") {
    return "all repos";
  }
  if (layer === "team") {
    return "team";
  }
  if (layer === "override") {
    return "session";
  }
  return undefined;
}

function PrefRow(props: {
  label: string;
  hint?: string;
  layer?: PreferenceLayer;
  children: ReactNode;
}) {
  const badge = layerLabel(props.layer);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 py-2.5 last:border-b-0 last:pb-0 first:pt-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-foreground">{props.label}</span>
          {badge ? <Badge variant="muted">{badge}</Badge> : null}
        </div>
        {props.hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{props.hint}</p> : null}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">{props.children}</div>
    </div>
  );
}

function Segmented<T extends string>(props: {
  value: T;
  options: Array<{ id: T; label: string }>;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-border/70 bg-muted/40 p-0.5" role="group" aria-label={props.ariaLabel}>
      {props.options.map((option) => {
        const active = option.id === props.value;
        return (
          <button
            key={option.id}
            type="button"
            disabled={props.disabled}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              active ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => props.onChange(option.id)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function SettingsPage(props: {
  status?: StatusSummary;
  busy: boolean;
  onBusy: (label: string) => void;
  onNotice: (message: string) => void;
}) {
  const { status, busy, onBusy, onNotice } = props;
  const [prefs, setPrefs] = useState<PreferenceSnapshot | undefined>(undefined);
  const [loadError, setLoadError] = useState("");
  const [portDraft, setPortDraft] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);

  const load = useCallback(async (scope: "user" | "repo") => {
    const next = await fetchPreferences(scope);
    setPrefs(next);
    applyAppearance(next.values.web_appearance);
    setPortDraft(String(next.local.web_port || ""));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load("repo").catch((err: unknown) => {
      if (!cancelled) {
        setLoadError(err instanceof Error ? err.message : "failed to load preferences");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const save = useCallback(async (args: ControlArgs, label: string) => {
    if (busy) {
      return;
    }
    onBusy(label);
    onNotice("");
    try {
      const next = await postControl("set_preferences", args) as PreferenceSnapshot;
      setPrefs(next);
      applyAppearance(next.values.web_appearance);
      setPortDraft(String(next.local.web_port || ""));
      onNotice(args.reset ? "Preferences reset" : "Preferences saved");
    } catch (err: unknown) {
      onNotice(err instanceof Error ? err.message : "save failed");
    } finally {
      onBusy("");
    }
  }, [busy, onBusy, onNotice]);

  if (loadError) {
    return <p className="text-sm text-destructive">{loadError}</p>;
  }
  if (!prefs) {
    return <p className="text-sm text-muted-foreground">Loading preferences…</p>;
  }

  const locked = prefs.locked;
  const scope = prefs.scope;
  const writePath = prefs.paths.write;
  const disable = busy || locked;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-foreground">Settings</h1>
          <p className="mt-1 max-w-xl text-[12px] text-muted-foreground">
            This repository overlay wins over your user file. MCP listen stays per checkout. The web console switch writes gitignored
            {" "}
            <span className="font-mono">.devctl/config.local.yaml</span>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={status?.mcp.running ? "success" : "muted"}>{status?.mcp.running ? "MCP up" : "MCP down"}</Badge>
          <Badge variant={status?.web.running ? "success" : "muted"}>{status?.web.running ? "Web up" : "Web down"}</Badge>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Scope</CardTitle>
        </CardHeader>
        <CardContent>
          <PrefRow label="Save to" hint={locked ? "DEVCTL_TUI_CONFIG is set — changes stay in this session." : writePath}>
            <Segmented
              ariaLabel="Preference save scope"
              value={scope}
              disabled={busy}
              options={[
                { id: "repo", label: "This repository" },
                { id: "user", label: "All repositories" },
              ]}
              onChange={(next) => {
                void load(next).catch((err: unknown) => onNotice(err instanceof Error ? err.message : "failed to load"));
              }}
            />
          </PrefRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent>
          <PrefRow label="Web console" hint="TUI theme still lives in the TUI." layer={prefs.layers.web_appearance}>
            <Segmented
              ariaLabel="Web console appearance"
              value={prefs.values.web_appearance}
              disabled={disable}
              options={[
                { id: "dark", label: "Dark" },
                { id: "light", label: "Light" },
              ]}
              onChange={(web_appearance) => void save({ scope, web_appearance }, "Saving appearance…")}
            />
          </PrefRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Input</CardTitle>
        </CardHeader>
        <CardContent>
          <PrefRow label="Scroll speed" hint="Lines moved by j/k in the TUI." layer={prefs.layers.scroll_speed}>
            <Segmented
              ariaLabel="Scroll speed"
              value={String(prefs.values.scroll_speed)}
              disabled={disable}
              options={[1, 2, 3, 4, 5, 6].map((speed) => ({ id: String(speed), label: String(speed) }))}
              onChange={(value) => void save({ scope, scroll_speed: Number(value) }, "Saving scroll speed…")}
            />
          </PrefRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Logs</CardTitle>
        </CardHeader>
        <CardContent>
          <PrefRow label="Timestamps" hint="Same as t in the TUI." layer={prefs.layers.log_timestamps}>
            <Segmented
              ariaLabel="Log timestamps"
              value={prefs.values.log_timestamps ? "on" : "off"}
              disabled={disable}
              options={[
                { id: "on", label: "On" },
                { id: "off", label: "Off" },
              ]}
              onChange={(value) => void save({ scope, log_timestamps: value === "on" }, "Saving timestamps…")}
            />
          </PrefRow>
          <PrefRow label="Metadata" hint="Same as m in the TUI." layer={prefs.layers.log_metadata}>
            <Segmented
              ariaLabel="Log metadata"
              value={prefs.values.log_metadata ? "on" : "off"}
              disabled={disable}
              options={[
                { id: "on", label: "On" },
                { id: "off", label: "Off" },
              ]}
              onChange={(value) => void save({ scope, log_metadata: value === "on" }, "Saving metadata…")}
            />
          </PrefRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Listeners</CardTitle>
        </CardHeader>
        <CardContent>
          <PrefRow label="Web console" hint={`Writes ${prefs.paths.local}. Loopback host is unchanged.`}>
            {confirmOff ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-warning">This tab will disconnect.</span>
                <Button type="button" size="xs" variant="destructive" disabled={busy} onClick={() => {
                  setConfirmOff(false);
                  void save({ scope, local: { web_enabled: false } }, "Turning web console off…");
                }}>
                  Turn off
                </Button>
                <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => setConfirmOff(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Segmented
                ariaLabel="Web console enabled"
                value={prefs.local.web_enabled ? "on" : "off"}
                disabled={busy}
                options={[
                  { id: "on", label: "On" },
                  { id: "off", label: "Off" },
                ]}
                onChange={(value) => {
                  if (value === "off" && prefs.local.web_enabled) {
                    setConfirmOff(true);
                    return;
                  }
                  void save({ scope, local: { web_enabled: value === "on" } }, "Saving web console…");
                }}
              />
            )}
          </PrefRow>
          <PrefRow label="Inspect body cap" hint="Default capture size for traffic and LLM bodies. A route or source that sets max_bytes still wins. Writes proxy.inspect_max_bytes and llm.capture_max_bytes, then reloads. New hops use the new cap.">
            <Segmented
              ariaLabel="Inspect body cap"
              value={String(prefs.local.inspect_max_bytes > 0 ? prefs.local.inspect_max_bytes : INSPECT_CAP_1_MIB)}
              disabled={busy}
              options={INSPECT_CAP_OPTIONS}
              onChange={(value) => void save({ scope, local: { inspect_max_bytes: Number(value) } }, "Saving inspect cap…")}
            />
          </PrefRow>
          <PrefRow label="Web port" hint="Reloads the listener after save.">
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const port = Number(portDraft);
                if (!Number.isInteger(port)) {
                  onNotice("Web port must be an integer");
                  return;
                }
                void save({ scope, local: { web_port: port } }, "Saving web port…");
              }}
            >
              <input
                className="h-7 w-24 rounded-md border border-input bg-transparent px-2 font-mono text-xs text-foreground"
                inputMode="numeric"
                value={portDraft}
                disabled={busy}
                aria-label="Web console port"
                onChange={(event) => setPortDraft(event.target.value)}
              />
              <Button type="submit" size="xs" variant="outline" disabled={busy}>Save</Button>
            </form>
          </PrefRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>About</CardTitle>
        </CardHeader>
        <CardContent>
          <PrefRow label="User file" hint="Defaults for every checkout.">
            <span className="max-w-[420px] truncate font-mono text-[11px] text-muted-foreground" title={prefs.paths.user}>{prefs.paths.user}</span>
          </PrefRow>
          <PrefRow label="Repo file" hint="Per-checkout overlay, including MCP listen.">
            <span className="max-w-[420px] truncate font-mono text-[11px] text-muted-foreground" title={prefs.paths.repo}>{prefs.paths.repo}</span>
          </PrefRow>
          <PrefRow label="Reset" hint="Restores advertised defaults in the current save scope. MCP listen is left as-is.">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={disable}
              onClick={() => void save({ scope, reset: true }, "Resetting preferences…")}
            >
              Restore defaults
            </Button>
          </PrefRow>
        </CardContent>
      </Card>
    </div>
  );
}
