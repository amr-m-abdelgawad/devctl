import { useCallback, useEffect, useState } from "react";
import { type Controller } from "../../../application/client-runtime.ts";
import type { DevctlConfig } from "../../../domain/config/types.ts";
import { humanMessage } from "../../../shared/errors.ts";

type Options = {
  controller?: Pick<Controller, "execService">;
  cfg?: DevctlConfig;
  envService: string;
  envName?: string;
};

export function useServiceEnvironment({
  controller,
  cfg,
  envService,
  envName = "",
}: Options) {
  const [resolvedEnvCache, setResolvedEnvCache] = useState<{ name: string; envName: string; env: Record<string, string> } | undefined>();
  const [resolvedEnvLoading, setResolvedEnvLoading] = useState(false);
  const [resolvedEnvError, setResolvedEnvError] = useState("");
  const envMatches = resolvedEnvCache?.name === envService && resolvedEnvCache.envName === envName;
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
    if (resolvedEnvCache?.name === envService && resolvedEnvCache.envName === envName) {
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
        setResolvedEnvCache({ name: envService, envName, env: result.environment ?? {} });
        setResolvedEnvError("");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setResolvedEnvError(humanMessage(err));
      })
      .finally(() => {
        if (!cancelled) {
          setResolvedEnvLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cfg, controller, envService, envName, resolvedEnvCache?.name, resolvedEnvCache?.envName]);

  const resolveEnvironment = useCallback(async (service: string) => {
    if (!controller) return;
    try {
      const result = await controller.execService(service, [], true);
      setResolvedEnvCache({ name: service, envName, env: result.environment ?? {} });
      setResolvedEnvError("");
    } catch (err) {
      setResolvedEnvError(humanMessage(err));
      throw err;
    }
  }, [controller, envName]);

  return { inspectorEnv, inspectorEnvStatus, inspectorEnvError, resolveEnvironment };
}
