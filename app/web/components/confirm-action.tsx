import { useState, type ReactNode } from "react";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.tsx";

export function ConfirmAction(props: {
  label: ReactNode;
  title: string;
  description: ReactNode;
  onConfirm: () => Promise<unknown> | void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const confirm = async (): Promise<void> => {
    setPending(true);
    setError("");
    try {
      await props.onConfirm();
      setOpen(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="outline" disabled={props.disabled} onClick={() => setOpen(true)}>
        {props.label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!pending) {
            setOpen(value);
            setError("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
            <DialogDescription asChild>
              <div>{props.description}</div>
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant={props.destructive ? "destructive" : "default"} disabled={pending} onClick={() => void confirm()}>
              {pending ? "Working…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
