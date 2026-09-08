import { useCallback, useEffect, useRef, useState } from "react";
import { type Controller } from "../../../application/client-runtime.ts";
import type { DevctlConfig } from "../../../domain/config/types.ts";
import { type DoctorProgress, type Report } from "../../../domain/doctor/types.ts";
import { type GoogleStatus } from "../../../domain/identity/google-status.ts";
import { humanMessage } from "../../../shared/errors.ts";
import { type StatusSnapshot } from "../../../domain/status.ts";
import { type Screen } from "../types.ts";
import { type TuiWorkspace } from "../workspace.ts";

import type { Dispatch, SetStateAction } from "react";

type Options = {
  controller?: Controller;
  workspace: TuiWorkspace;
  cfg?: DevctlConfig;
  snap?: StatusSnapshot;
  screen: Screen;
  configReloadError?: string;
  setSnap: Dispatch<SetStateAction<StatusSnapshot | undefined>>;
  setStatus: (status: string) => void;
};

export function useDiagnostics({
  controller,
  workspace,
  cfg,
  snap,
  screen,
  configReloadError,
  setSnap,
  setStatus,
}: Options) {
  const { detectGoogle, runDoctor, loadPath } = workspace;
  const [google, setGoogle] = useState<GoogleStatus | undefined>();
  const [doctor, setDoctor] = useState<Report | undefined>();
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [doctorError, setDoctorError] = useState("");
  const [doctorTick, setDoctorTick] = useState(0);
  const [doctorProgress, setDoctorProgress] = useState<DoctorProgress>({ active: "Preparing diagnostics", checks: [] });
  const doctorRunKey = useRef<{ cfg: unknown; tick: number; sessionID: string; reloadError?: string } | undefined>(undefined);
  const doctorRunGeneration = useRef(0);
  const refreshAuth = useCallback(async () => {
    if (!controller) {
      setStatus("Supervisor is not running");
      return;
    }
    setStatus("Probing configured identities…");
    try {
      const identity = await controller.refreshAuth();
      setSnap((current) => (current ? { ...current, identity } : current));
      const statuses = Object.values(identity.service_account_status);
      const available = statuses.filter((value) => value === "available").length;
      const unavailable = statuses.filter((value) => value === "unavailable").length;
      setStatus(
        statuses.length === 0
          ? "Identity refreshed — no service accounts configured"
          : `Identity refreshed — ${available} available${unavailable > 0 ? `, ${unavailable} unavailable` : ""}`,
      );
    } catch (err) {
      setStatus(humanMessage(err));
    }
  }, [controller]);

  useEffect(() => {
    void detectGoogle(cfg?.google.project_id ?? "")
      .then(setGoogle)
      .catch((err: unknown) => {
        setStatus(humanMessage(err));
      });
  }, [cfg?.google.project_id, snap?.identity.project]);

  useEffect(() => {
    if (screen !== "doctor" || !cfg) {
      return;
    }
    const previous = doctorRunKey.current;
    const sessionID = snap?.session_id ?? "";
    if (previous?.cfg === cfg && previous.tick === doctorTick && previous.sessionID === sessionID && previous.reloadError === configReloadError) {
      return;
    }
    doctorRunKey.current = { cfg, tick: doctorTick, sessionID, reloadError: configReloadError };
    const generation = ++doctorRunGeneration.current;
    setDoctorLoading(true);
    setDoctorError("");
    setDoctorProgress({ active: "Preparing diagnostics", checks: [] });
    let repositoryConfigError: string | undefined;
    if (cfg.configPath !== "") {
      repositoryConfigError = "";
      try {
        loadPath(cfg.repoRoot, cfg.configPath);
      } catch (err) {
        repositoryConfigError = humanMessage(err);
      }
    }
    void runDoctor(
      cfg,
      (progress) => {
        if (generation === doctorRunGeneration.current) {
          setDoctorProgress(progress);
        }
      },
      { services: snap?.services, proxyRunning: snap?.proxy.running, repositoryConfigError },
    )
      .then((report) => {
        if (generation !== doctorRunGeneration.current) {
          return;
        }
        setDoctor(report);
      })
      .catch((err: unknown) => {
        if (generation !== doctorRunGeneration.current) {
          return;
        }
        setDoctorError(humanMessage(err));
      })
      .finally(() => {
        if (generation === doctorRunGeneration.current) {
          setDoctorLoading(false);
        }
      });
  }, [screen, cfg, doctorTick, snap?.session_id, configReloadError]);

  return { google, setGoogle, doctor, doctorLoading, doctorError, doctorProgress, setDoctorTick, refreshAuth };
}
