import { useEffect, useState } from "react";
import { fetchLogin } from "../api.ts";
import type { WebLoginState } from "../../src/ports/web-host.ts";
import { useOperatorAction } from "../operator.ts";
import { ConfirmAction } from "./confirm-action.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";
import { Input } from "./ui/input.tsx";
import { Badge } from "./ui/badge.tsx";

export function AuthControls() {
  const { pending, error, run } = useOperatorAction();
  const [login, setLogin] = useState<WebLoginState | null>(null);
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState("");
  const active = login && ["starting", "awaiting_code", "finishing"].includes(login.phase);
  useEffect(() => {
    let cancelled = false;
    const poll = (): void => {
      void fetchLogin()
        .then((next) => {
          if (!cancelled) setLogin(next);
        })
        .catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Authentication controls</CardTitle>
        {login ? (
          <Badge variant={login.phase === "failed" ? "destructive" : login.phase === "succeeded" ? "success" : "muted"}>
            {login.phase.replaceAll("_", " ")}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-xs text-muted-foreground">
          Sign in with Google on this browser, then return the authorization code to gcloud on the devctl machine.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={Boolean(pending) || Boolean(active)}
            onClick={() => {
              setNotice("");
              void run<WebLoginState>("auth_start").then((next) => {
                if (next) setLogin(next);
              });
            }}
          >
            Sign in with Google
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(pending)}
            onClick={() => {
              void run("auth_refresh").then((next) => {
                if (next) setNotice("Identity and service account probes refreshed.");
              });
            }}
          >
            Refresh identity
          </Button>
          <ConfirmAction
            label="Sign out"
            title="Revoke Application Default Credentials?"
            description="This signs out the Google Cloud ADC account on the machine running devctl. Cloud-backed services and other tools using that account may need you to sign in again."
            disabled={Boolean(pending)}
            destructive
            onConfirm={async () => {
              const next = await run("auth_logout", { confirm: true });
              if (next) setNotice("Application Default Credentials revoked.");
            }}
          />
          <ConfirmAction
            label="Clear cached tokens"
            title="Clear cached credentials?"
            description="Cached tokens will be minted again on their next use. Application Default Credentials stay signed in."
            disabled={Boolean(pending)}
            onConfirm={async () => {
              const next = await run("auth_invalidate", { confirm: true });
              if (next) setNotice("Cached credentials cleared.");
            }}
          />
        </div>
        {login?.url && login.phase === "awaiting_code" ? (
          <div className="flex flex-col gap-3 rounded-lg border p-4">
            <Button variant="outline" asChild>
              <a href={login.url} target="_blank" rel="noreferrer noopener">
                Open Google sign-in ↗
              </a>
            </Button>
            <label className="flex flex-col gap-2 text-xs">
              Authorization code
              <Input
                type="password"
                autoComplete="off"
                value={code}
                onChange={(event) => setCode(event.currentTarget.value)}
                placeholder="Paste the code Google gives you"
              />
            </label>
            <Button
              disabled={!code.trim() || Boolean(pending)}
              onClick={() => {
                const value = code;
                setCode("");
                void run<WebLoginState>("auth_code", { id: login.id, code: value }).then((next) => {
                  if (next) setLogin(next);
                });
              }}
            >
              Complete sign-in
            </Button>
          </div>
        ) : login?.phase === "starting" ? (
          <p className="text-xs text-muted-foreground">Waiting for gcloud to create a sign-in link…</p>
        ) : login?.phase === "finishing" ? (
          <p className="text-xs text-muted-foreground">Completing sign-in and refreshing identity…</p>
        ) : login?.phase === "succeeded" ? (
          <p role="status" className="text-xs text-success">
            Google sign-in completed.
          </p>
        ) : null}
        {active ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (login) void run("auth_cancel", { id: login.id }).then(() => fetchLogin().then(setLogin));
            }}
          >
            Cancel sign-in
          </Button>
        ) : null}
        {error || login?.error ? (
          <p role="alert" className="text-xs text-destructive">
            {error || login?.error}
          </p>
        ) : notice ? (
          <p role="status" className="text-xs text-success">
            {notice}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
