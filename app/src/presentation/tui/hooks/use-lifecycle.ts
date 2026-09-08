import { useCallback, useState } from "react";
import { type Controller } from "../../../application/client-runtime.ts";
import type { DevctlConfig } from "../../../domain/config/types.ts";
import { type Plan } from "../../../domain/service/services.ts";
import { humanMessage } from "../../../shared/errors.ts";
import { type StatusSnapshot } from "../../../domain/status.ts";
import { formatPlanSummary, formatStarted, formatStopped, planServices } from "../helpers/lifecycle.ts";
import { isActiveRuntime } from "../helpers/services.ts";
import { type LifecycleKind, type Overlay } from "../types.ts";
import { type TuiWorkspace } from "../workspace.ts";

type Options = {
  controller?: Pick<Controller, "start" | "stop" | "restart">;
  workspace: TuiWorkspace;
  cfg?: DevctlConfig;
  snap?: StatusSnapshot;
  refresh: () => Promise<StatusSnapshot | undefined>;
  setStatus: (status: string) => void;
  setOverlay: (overlay: Overlay) => void;
};

export function useLifecycle({
  controller,
  workspace,
  cfg,
  snap,
  refresh,
  setStatus,
  setOverlay,
}: Options) {
  const { resolveStartRequest, startupPlan, shutdownPlan } = workspace;
  const [plan, setPlan] = useState<Plan | undefined>();
  const [planInitiallyRunning, setPlanInitiallyRunning] = useState<string[]>([]);
  const [planBusy, setPlanBusy] = useState(false);
  const [lifecycle, setLifecycle] = useState<LifecycleKind>("start");
  const beginStart = useCallback(
    async (targets: string[], profileName: string) => {
      if (!controller || !cfg) {
        setStatus("no configuration loaded");
        return;
      }
      try {
        const named = targets.length > 0;
        const resolved = resolveStartRequest(cfg, {
          services: targets,
          profile: named ? undefined : profileName,
        });
        const nextPlan = startupPlan(cfg, resolved.services, resolved.profile);
        setLifecycle("start");
        setPlanInitiallyRunning(nextPlan.waves.flat().filter((name) => isActiveRuntime(snap?.services[name])));
        setPlan(nextPlan);
        setOverlay("plan");
        setPlanBusy(true);
        const needed = resolved.services.filter((name) => !isActiveRuntime(snap?.services[name]));
        const result = await controller.start({
          services: needed.length > 0 ? needed : resolved.services,
          profile: named ? undefined : resolved.profile,
        });
        await refresh();
        setPlanBusy(false);
        setStatus(formatStarted(result));
      } catch (err) {
        setPlanBusy(false);
        await refresh();
        setStatus(humanMessage(err));
      }
    },
    [cfg, controller, refresh, snap],
  );

  const beginStop = useCallback(
    async (targets: string[]) => {
      if (!controller || !cfg) {
        setStatus("no configuration loaded");
        return;
      }
      const selected =
        targets.length > 0
          ? targets
          : Object.entries(snap?.services ?? {})
              .filter(([, rt]) => rt.state !== "STOPPED" && rt.state !== "UNKNOWN")
              .map(([name]) => name);
      if (selected.length === 0) {
        setStatus("nothing to stop");
        return;
      }
      try {
        const nextPlan = shutdownPlan(cfg, selected);
        setLifecycle("stop");
        setPlanInitiallyRunning([]);
        setPlan(nextPlan);
        setOverlay("plan");
        setPlanBusy(true);
        await controller.stop(targets);
        await refresh();
        setPlanBusy(false);
        setStatus(formatStopped(nextPlan));
      } catch (err) {
        setPlanBusy(false);
        await refresh();
        setStatus(humanMessage(err));
      }
    },
    [cfg, controller, refresh, snap],
  );

  const beginRestart = useCallback(
    async (targets: string[], profileName: string) => {
      if (!controller || !cfg) {
        setStatus("no configuration loaded");
        return;
      }
      try {
        const planned = planServices(cfg, targets, profileName);
        const nextPlan = startupPlan(cfg, planned.services, planned.profile);
        setLifecycle("restart");
        setPlanInitiallyRunning([]);
        setPlan(nextPlan);
        setOverlay("plan");
        setPlanBusy(true);
        await controller.restart(targets);
        await refresh();
        setPlanBusy(false);
        setStatus(formatPlanSummary(nextPlan) === "" ? "Restarted selected services" : `Restarted ${formatPlanSummary(nextPlan)}`);
      } catch (err) {
        setPlanBusy(false);
        await refresh();
        setStatus(humanMessage(err));
      }
    },
    [cfg, controller, refresh],
  );

  return { plan, planInitiallyRunning, planBusy, lifecycle, beginStart, beginStop, beginRestart };
}
