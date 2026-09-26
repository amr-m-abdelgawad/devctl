import type { RouteGrpcOkEntry, RouteGrpcOkLog } from "../config/types.ts";

export const GRPC_OK_STATUS_MIN = 0;
export const GRPC_OK_STATUS_MAX = 16;

export type GrpcOkMatch = {
  log: RouteGrpcOkLog;
  inspect: boolean;
};

// A listed gRPC status is not a proxy error when the :path suffix matches
// (or methods is omitted — then every method on the route). Status 0 is
// already a success; a rule for it only customizes log and inspect capture.
// inspect is false only when the rule sets inspect: false.
export function matchGrpcOk(
  rules: readonly RouteGrpcOkEntry[] | undefined,
  status: string | number,
  methodPath: string,
): GrpcOkMatch | undefined {
  if (!rules || rules.length === 0) {
    return undefined;
  }
  const code = typeof status === "number" ? status : Number(status);
  if (!Number.isFinite(code)) {
    return undefined;
  }
  for (const rule of rules) {
    if (rule.status === code && methodMatches(rule.methods, methodPath)) {
      return {
        log: rule.log === "silent" ? "silent" : "info",
        inspect: rule.inspect !== false,
      };
    }
  }
  return undefined;
}

function methodMatches(methods: readonly string[] | undefined, path: string): boolean {
  if (!methods || methods.length === 0) {
    return true;
  }
  return methods.some((method) => {
    const suffix = method.startsWith("/") ? method : `/${method}`;
    return path === method || path.endsWith(suffix);
  });
}
