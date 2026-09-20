import { useCallback, useMemo, useState } from "react";
import { restartDependents } from "../cascade.ts";
import { RestartConfirmBanner } from "../components/restart-confirm.tsx";
import type { RunControl } from "../control.ts";
import type { ConfigService } from "../types.ts";

export function useCascadeRestart(config: ConfigService[], onControl: RunControl, busy = false) {
  const [pending, setPending] = useState<string[]>([]);
  const dependents = useMemo(() => restartDependents(config, pending), [config, pending]);

  const requestRestart = useCallback((names: string[]): void => {
    if (names.length === 0) {
      return;
    }
    const extra = restartDependents(config, names);
    if (extra.length === 0) {
      onControl("restart_services", { services: names }, `Restarting ${names.join(", ")}…`);
      return;
    }
    setPending(names);
  }, [config, onControl]);

  const banner = pending.length > 0 && dependents.length > 0 ? (
    <RestartConfirmBanner
      names={pending}
      dependents={dependents}
      busy={busy}
      onNamed={() => {
        onControl("restart_services", { services: pending, cascade: false }, `Restarting ${pending.join(", ")}…`);
        setPending([]);
      }}
      onCascade={() => {
        onControl("restart_services", { services: pending, cascade: true }, `Restarting ${pending.join(", ")} + dependents…`);
        setPending([]);
      }}
      onCancel={() => setPending([])}
    />
  ) : null;

  return { requestRestart, banner };
}
