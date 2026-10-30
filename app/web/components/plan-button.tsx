import { useState } from "react";
import type { Plan } from "../../src/domain/service/services.ts";
import { useOperatorAction } from "../operator.ts";
import type { RunControl } from "../control.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { ChoiceGroup } from "./filters.tsx";

export function PlanButton(props: { services?: string[]; profile?: string; busy?: boolean; onControl: RunControl }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("start");
  const [plan, setPlan] = useState<Plan>();
  const { run, pending, error } = useOperatorAction();
  const load = async (action: string): Promise<void> => {
    setPlan(undefined);
    const next = await run<Plan>(`plan_${action}`, { services: props.services, profile: props.profile });
    if (next) setPlan(next);
  };
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={props.busy}
        onClick={() => {
          setOpen(true);
          setKind("start");
          void load("start");
        }}
      >
        Preview plan
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Service lifecycle plan</DialogTitle>
            <DialogDescription>
              {props.profile ? `Profile: ${props.profile}` : props.services?.join(", ") || "Current workspace"}
            </DialogDescription>
          </DialogHeader>
          <ChoiceGroup
            label="Plan operation"
            value={kind}
            onChange={(value) => {
              setKind(value);
              void load(value);
            }}
            options={[
              { value: "start", label: "Start" },
              { value: "stop", label: "Stop" },
            ]}
          />
          {pending ? <p className="text-xs text-muted-foreground">Calculating dependency waves…</p> : null}
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {plan ? (
            <div className="plan-waves">
              {plan.waves.map((wave, index) => (
                <div key={index}>
                  <span className="font-mono text-xs text-primary">Wave {index + 1}</span>
                  <p className="break-words text-sm">{wave.join(", ")}</p>
                </div>
              ))}
              {plan.blockers?.map((blocker) => (
                <p key={`${blocker.name}:${blocker.message}`} className="text-xs text-warning">
                  {blocker.name}: {blocker.message}
                </p>
              ))}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button
              disabled={!plan || !plan.waves.length || Boolean(plan.blockers?.length) || Boolean(pending) || props.busy}
              variant={kind === "stop" ? "destructive" : "default"}
              onClick={() => {
                props.onControl(
                  kind === "stop" ? "stop_services" : "start_services",
                  kind === "stop"
                    ? { services: plan?.waves.flat() }
                    : props.services?.length
                      ? { services: props.services }
                      : { profile: props.profile },
                  `${kind === "stop" ? "Stopping" : "Starting"} services…`,
                );
                setOpen(false);
              }}
            >
              {kind === "stop" ? "Stop planned services" : "Start planned services"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
