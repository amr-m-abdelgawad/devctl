import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { Button } from "./ui/button.tsx";

export function RestartConfirmBanner(props: {
  names: string[];
  dependents: string[];
  busy: boolean;
  onNamed: () => void;
  onCascade: () => void;
  onCancel: () => void;
}) {
  const named = props.names.join(", ") || "selected services";
  const extra = props.dependents.join(", ");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restart dependents too?</DialogTitle>
          <DialogDescription>Choose how to restart {named}.</DialogDescription>
        </DialogHeader>
        <p className="max-h-40 overflow-auto break-words text-sm text-muted-foreground">
          Also depends on this selection: <span className="text-foreground">{extra}</span>
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button variant="outline" disabled={props.busy} onClick={props.onNamed}>
            Selected only
          </Button>
          <Button disabled={props.busy} onClick={props.onCascade}>
            Include dependents
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
