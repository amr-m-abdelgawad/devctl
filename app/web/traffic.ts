import type { TrafficCallRow, TrafficPayload } from "./types.ts";

export type TrafficBodyMode = "json" | "raw";

export function trafficPayloadView(payload: TrafficPayload | undefined, mode: TrafficBodyMode): string {
  if (!payload) {
    return "";
  }
  if (payload.omitted) {
    return payload.truncated ? "(omitted, truncated at capture cap)" : "(omitted — streamed or over the capture cap)";
  }
  if (mode === "raw") {
    return payload.data ?? payload.text ?? "";
  }
  return payload.text ?? payload.data ?? "";
}

export function trafficIsError(call: Pick<TrafficCallRow, "status" | "grpc_status">): boolean {
  if (call.status >= 400 || call.status === 0) {
    return true;
  }
  return Boolean(call.grpc_status && call.grpc_status !== "0");
}

export function trafficStatusLabel(call: Pick<TrafficCallRow, "status" | "grpc_status">): string {
  if (call.grpc_status && call.grpc_status !== "") {
    return `${call.status}/g${call.grpc_status}`;
  }
  return String(call.status);
}
