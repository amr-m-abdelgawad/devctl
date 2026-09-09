import { useCallback, useState } from "react";
import type { CliRenderer } from "@opentui/core";
import { defaultStarterAnswers, SETUP_FIELDS, type StarterAnswers } from "../../../application/setup-starter.ts";
import type { Controller } from "../../../application/client-runtime.ts";
import { writeStarter } from "../../cli/setup.ts";
import { humanMessage } from "../../../shared/errors.ts";
import { withSuspendedRenderer } from "../suspend.ts";
import { type Overlay } from "../types.ts";
import { applySetupDraft, setupWizardDraft } from "../overlays/SetupWizard.tsx";
import type { TuiWorkspace } from "../workspace.ts";

type Options = {
  workspace: Pick<TuiWorkspace, "detectGoogle" | "loginGoogle" | "openTui">;
  renderer: CliRenderer;
  setOverlay: (overlay: Overlay) => void;
  setStatus: (status: string) => void;
  setScreen: (screen: "dashboard") => void;
  onAttached?: (controller: Controller) => void;
  setController: (controller: Controller) => void;
  setCfg: (cfg: Controller["cfg"]) => void;
  setBootError: (error: string | undefined) => void;
};

export function useSetupWizard({
  workspace,
  renderer,
  setOverlay,
  setStatus,
  setScreen,
  onAttached,
  setController,
  setCfg,
  setBootError,
}: Options) {
  const repo = process.cwd();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<StarterAnswers>(() => defaultStarterAnswers(repo));
  const [draft, setDraft] = useState("");
  const [authStatus, setAuthStatus] = useState("Checking Application Default Credentials…");

  const startWizard = useCallback(() => {
    const initial = defaultStarterAnswers(repo);
    setStep(0);
    setAnswers(initial);
    setDraft(setupWizardDraft("repo", initial, repo));
    setOverlay("setup-wizard");
    void workspace.detectGoogle("").then((st) => {
      setAnswers((current) => ({ ...current, project: st.projectID || current.project }));
      setAuthStatus(
        st.adcAvailable
          ? `ADC available${st.userEmail ? ` (${st.userEmail})` : ""}. Enter continues.`
          : "ADC is not available. Enter runs gcloud ADC login on this TTY, then continues.",
      );
    });
  }, [repo, setOverlay, workspace]);

  const finishWizard = useCallback(
    async (finalAnswers: StarterAnswers) => {
      try {
        writeStarter(repo, finalAnswers);
        const next = await workspace.openTui(repo, "");
        onAttached?.(next);
        setController(next);
        setCfg(next.cfg);
        setBootError(undefined);
        setOverlay("none");
        setScreen("dashboard");
        setStatus(`Wrote .devctl/config.yaml and attached the daemon`);
      } catch (err) {
        setStatus(humanMessage(err));
      }
    },
    [onAttached, repo, setBootError, setCfg, setController, setOverlay, setScreen, setStatus, workspace],
  );

  const advanceWizard = useCallback(async () => {
    const field = SETUP_FIELDS[step];
    if (!field) {
      return;
    }
    let nextAnswers = applySetupDraft(field.id, answers, draft, repo);
    if (field.id === "auth") {
      const st = await workspace.detectGoogle(nextAnswers.project);
      if (!st.adcAvailable) {
        try {
          await withSuspendedRenderer(renderer, () => workspace.loginGoogle());
        } catch (err) {
          setStatus(humanMessage(err));
        }
      }
    }
    setAnswers(nextAnswers);
    if (field.id === "write") {
      await finishWizard(nextAnswers);
      return;
    }
    const nextStep = Math.min(step + 1, SETUP_FIELDS.length - 1);
    const nextField = SETUP_FIELDS[nextStep];
    setStep(nextStep);
    setDraft(nextField ? setupWizardDraft(nextField.id, nextAnswers, repo) : "");
  }, [answers, draft, finishWizard, renderer, repo, step, workspace, setStatus]);

  return { step, answers, draft, authStatus, repo, setDraft, startWizard, advanceWizard };
}
