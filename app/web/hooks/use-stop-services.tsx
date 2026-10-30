import { useState } from "react";
import { restartDependents } from "../cascade.ts";
import type { RunControl } from "../control.ts";
import type { ConfigService } from "../types.ts";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.tsx";

export function useStopServices(config: ConfigService[], onControl: RunControl, busy: boolean) {
  const [pending, setPending] = useState<string[] | undefined>();
  const extra = restartDependents(config, pending ?? []);
  return {
    requestStop: (names: string[]) => setPending(names),
    confirmation: (
      <Dialog
        open={pending !== undefined}
        onOpenChange={(open) => {
          if (!open) setPending(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pending?.length ? `Stop ${pending.length === 1 ? pending[0] : `${pending.length} services`}?` : "Stop all services?"}
            </DialogTitle>
            <DialogDescription>
              {pending?.length
                ? "Services that depend on this selection will also stop."
                : "This stops every running service in this workspace."}
            </DialogDescription>
          </DialogHeader>
          {pending?.length ? <p className="max-h-36 overflow-auto break-words font-mono text-xs">{pending.join(", ")}</p> : null}
          {extra.length ? (
            <div className="max-h-48 overflow-auto break-words rounded-lg bg-warning/10 p-3 text-xs text-warning">
              Also stops: {extra.join(", ")}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                onControl("stop_services", pending?.length ? { services: pending } : {}, "Stopping services…");
                setPending(undefined);
              }}
            >
              Stop services
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ),
  };
}
