import { ArrowUpCircle, Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "./ui/button.tsx";
import type { UpdateCheckPayload } from "../types.ts";

const COPY_FEEDBACK_MS = 2500;

export function UpdateNotice(props: {
  check: UpdateCheckPayload;
  onLater: () => void;
  onDismiss: () => void;
}) {
  const { check, onLater, onDismiss } = props;
  const [copied, setCopied] = useState(false);
  const install = check.hint;
  const copyInstall = (): void => {
    if (install === "") {
      return;
    }
    setCopied(true);
    void navigator.clipboard.writeText(install).then(() => {
      window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    }).catch(() => {
      setCopied(false);
    });
  };
  return (
    <div
      role="status"
      className="border-b border-warning/35 bg-[color-mix(in_oklab,var(--warning)_14%,var(--card))] px-5 py-2.5"
    >
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2">
        <ArrowUpCircle className="size-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium tracking-tight text-foreground">
            devctl {check.latest} is available
          </p>
          <p className="text-[12px] text-muted-foreground">
            You&apos;re on {check.current}. After installing, restart with{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">devctl down</code>
            {" "}and start again.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {install !== "" ? (
            <Button
              type="button"
              size="xs"
              variant={copied ? "secondary" : "default"}
              aria-live="polite"
              onClick={copyInstall}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy install command"}
            </Button>
          ) : null}
          <Button type="button" size="xs" variant="ghost" onClick={onLater}>
            Later
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={onDismiss}>
            Don&apos;t remind me
          </Button>
        </div>
      </div>
    </div>
  );
}
