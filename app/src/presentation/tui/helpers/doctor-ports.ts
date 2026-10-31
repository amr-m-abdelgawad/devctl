import { busyPortHolders, FREE_ALL_PORT_MINIMUM } from "../../../domain/doctor/report.ts";
import type { Check } from "../../../domain/doctor/types.ts";
import type { ConfirmDetail } from "../types.ts";

export type FreeAllPrompt = { kind: "confirm"; detail: ConfirmDetail } | { kind: "status"; status: string };

const NO_ERROR_PORTS = "No error ports to free";
const ONE_ERROR_PORT = "Click free on that port, or select it and press enter";

export function freeAllPrompt(checks: readonly Check[]): FreeAllPrompt {
  const holders = busyPortHolders(checks);
  if (holders.length < FREE_ALL_PORT_MINIMUM) {
    return { kind: "status", status: holders.length === 0 ? NO_ERROR_PORTS : ONE_ERROR_PORT };
  }
  return {
    kind: "confirm",
    detail: {
      ports: holders.map((holder) => ({ port: holder.port, pid: holder.pid, process: holder.command })),
    },
  };
}
