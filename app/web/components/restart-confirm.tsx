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
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px]">
      <span>
        <span className="font-medium">Restart dependents?</span>{" "}
        {named} has dependents ({extra}). Named-only restarts just those services. Cascade also restarts dependents.
      </span>
      <div className="flex gap-1">
        <Button type="button" size="xs" variant="outline" disabled={props.busy} onClick={props.onNamed}>Named only</Button>
        <Button type="button" size="xs" disabled={props.busy} onClick={props.onCascade}>Cascade</Button>
        <Button type="button" size="xs" variant="ghost" onClick={props.onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
