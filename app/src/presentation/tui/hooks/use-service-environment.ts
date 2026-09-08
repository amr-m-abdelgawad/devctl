import { useCallback, useEffect, useState } from "react";
import { type Controller } from "../../../application/client-runtime.ts";
import type { DevctlConfig } from "../../../domain/config/types.ts";
import { humanMessage } from "../../../shared/errors.ts";

type Options = {
  controller?: Pick<Controller, "execService">;
  cfg?: DevctlConfig;
  envService: string;
};

export function useServiceEnvironment({
  controller,
  cfg,
  envService,
}: Options) {
  const [resolvedEnvCache, setResolvedEnvCache] = useState<{ name: string; env: Record<string, string> } | undefined>();
  const [resolvedEnvLoading, setResolvedEnvLoading] = useState(false);
  const [resolvedEnvError, setResolvedEnvError] = useState("");
  const envMatches = resolvedEnvCache?.name === envService;
  const inspectorEnv = envMatches ? resolvedEnvCache?.env : undefined;
  const inspectorEnvStatus: "config" | "loading" | "resolved" | "error" = envService === "" ? "config" : resolvedEnvLoading && !envMatches ? "loading" : envMatches ? "resolved" : resolvedEnvError !== "" ? "error" : "config";
  const inspectorEnvError = envMatches || envService === "" ? "" : resolvedEnvError;

  useEffect(() => {
    setResolvedEnvCache(undefined);
    setResolvedEnvError("");
  }, [cfg]);

  useEffect(() => {
    if (!controller || envService === "" || !cfg?.services[envService]) {
      return;
    }
    if (resolvedEnvCache?.name === envService) {
      return;
    }
    let cancelled = false;
    setResolvedEnvLoading(true);
    setResolvedEnvError("");
    void controller
      .execService(envService, [], true)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setResolvedEnvCache({ name: envService, env: result.environment ?? {} });
        setResolvedEnvError("");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setResolvedEnvError(humanMessage(err));
      })
      .finally(() => {
        setResolvedEnvLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cfg, controller, envService, resolvedEnvCache?.name]);

  const resolveEnvironment = useCallback(async (service: string) => {
    if (!controller) return;
    try {
      const result = await controller.execService(service, [], true);
      setResolvedEnvCache({ name: service, env: result.environment ?? {} });
      setResolvedEnvError("");
    } catch (err) {
      setResolvedEnvError(humanMessage(err));
      throw err;
    }
  }, [controller]);

  return { inspectorEnv, inspectorEnvStatus, inspectorEnvError, resolveEnvironment };
}
