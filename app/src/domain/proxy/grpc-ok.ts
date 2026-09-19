import type { RouteGrpcOkEntry, RouteGrpcOkLog } from "../config/types.ts";

export const GRPC_OK_STATUS_MIN = 1;
export const GRPC_OK_STATUS_MAX = 16;

// A listed non-zero gRPC status is not a proxy error when the :path suffix
// matches (or methods is omitted — then every method on the route).
export function matchGrpcOk(
  rules: readonly RouteGrpcOkEntry[] | undefined,
  status: string | number,
  methodPath: string,
): RouteGrpcOkLog | undefined {
  if (!rules || rules.length === 0) {
    return undefined;
  }
  const code = typeof status === "number" ? status : Number(status);
  if (!Number.isFinite(code)) {
    return undefined;
  }
  for (const rule of rules) {
    if (rule.status !== code) {
      continue;
    }
    if (!methodMatches(rule.methods, methodPath)) {
      continue;
    }
    return rule.log === "silent" ? "silent" : "info";
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
