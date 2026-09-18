import { Command } from "commander";
import { setTimeout as delay } from "node:timers/promises";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import type { TrafficCall, TrafficCallFilter, TrafficCallPage, TrafficPayload } from "../../domain/traffic/traffic.ts";
import { configFlag, writeOut } from "./shared.ts";

const DETAIL_LABEL_WIDTH = 10;

function formatCaller(call: TrafficCall): string {
  return call.caller && call.caller.trim() !== "" ? call.caller : "—";
}

function formatDuration(call: TrafficCall): string {
  if (call.durationMs === undefined) {
    return "—";
  }
  return `${call.durationMs}ms`;
}

function formatStatus(call: TrafficCall): string {
  if (call.grpcStatus !== undefined && call.grpcStatus !== "") {
    return `${call.status}/g${call.grpcStatus}`;
  }
  return String(call.status);
}

export function formatTrafficCallLine(call: TrafficCall): string {
  const time = call.timestamp.slice(11, 19) || call.timestamp;
  return `${time} ${call.transport.padEnd(4)} ${formatStatus(call).padEnd(8)} ${formatCaller(call).padEnd(14)} ${call.method.padEnd(7)} ${call.route.padEnd(16)} ${formatDuration(call).padEnd(8)} ${call.path} ${call.id}\n`;
}

export async function followTrafficCalls(
  fetchPage: () => Promise<TrafficCallPage>,
  onCall: (call: TrafficCall) => void,
  signal: AbortSignal,
  pollMs = 1000,
): Promise<void> {
  const seen = new Set<string>();
  const emit = (calls: readonly TrafficCall[]): void => {
    for (const call of [...calls].reverse()) {
      if (!seen.has(call.id)) {
        seen.add(call.id);
        onCall(call);
      }
    }
  };
  let page = await fetchPage();
  emit(page.calls);
  while (!signal.aborted) {
    try {
      await delay(pollMs, undefined, { signal });
    } catch {
      return;
    }
    page = await fetchPage();
    emit(page.calls);
  }
}

function formatPayload(label: string, payload?: TrafficPayload): string {
  if (!payload) {
    return "";
  }
  return `${label.padEnd(DETAIL_LABEL_WIDTH)}${JSON.stringify(payload, null, 2)}\n`;
}

export function addTraffic(root: Command, runtime: ClientRuntime): void {
  const traffic = root.command("traffic").description("inspect proxied HTTP and gRPC request bodies");
  traffic
    .option("--route <name>", "filter by proxy route name")
    .option("--caller <name>", "filter by originating service (use '-' or 'none' for calls with no caller)")
    .option("--method <method>", "filter by HTTP method")
    .option("--status <status>", "HTTP status, grpc-status, ok, or error")
    .option("--transport <kind>", "http or grpc")
    .option("--search <text>", "substring search")
    .option("--since <timestamp>", "only calls at or after this ISO timestamp")
    .option("--until <timestamp>", "only calls at or before this ISO timestamp")
    .option("--json", "JSONL output")
    .option("-f, --follow", "keep printing new matching calls until interrupted")
    .action(async (opts: {
      route?: string;
      caller?: string;
      method?: string;
      status?: string;
      transport?: string;
      search?: string;
      since?: string;
      until?: string;
      json?: boolean;
      follow?: boolean;
    }) => {
      const ctrl = await runtime.openController("", configFlag(root), true);
      try {
        const filter: TrafficCallFilter = {
          route: opts.route,
          caller: opts.caller === "none" ? "-" : opts.caller,
          method: opts.method,
          status: opts.status,
          transport: opts.transport === "http" || opts.transport === "grpc" ? opts.transport : undefined,
          search: opts.search,
          since: opts.since,
          until: opts.until,
        };
        const printCall = (call: TrafficCall): void => {
          writeOut(opts.json ? `${JSON.stringify(call)}\n` : formatTrafficCallLine(call));
        };
        if (opts.follow) {
          const abort = new AbortController();
          const onSignal = (): void => abort.abort();
          process.on("SIGINT", onSignal);
          process.on("SIGTERM", onSignal);
          try {
            await followTrafficCalls(() => ctrl.trafficCallsPage(filter), printCall, abort.signal);
          } finally {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
          }
          return;
        }
        const page = await ctrl.trafficCallsPage(filter);
        for (const call of page.calls) {
          printCall(call);
        }
      } finally {
        await ctrl.close();
      }
    });
  traffic
    .command("show")
    .argument("<id>", "call id")
    .option("--json", "JSON output")
    .action(async (id: string, opts: { json?: boolean }) => {
      const ctrl = await runtime.openController("", configFlag(root), true);
      try {
        const call = await ctrl.getTrafficCall(id);
        if (!call) {
          writeOut(`traffic call ${id} not found\n`);
          process.exitCode = 1;
          return;
        }
        if (opts.json) {
          writeOut(`${JSON.stringify(call, null, 2)}\n`);
          return;
        }
        writeOut(formatTrafficCallLine(call));
        writeOut(`${"caller".padEnd(DETAIL_LABEL_WIDTH)}${formatCaller(call)}\n`);
        writeOut(`${"route".padEnd(DETAIL_LABEL_WIDTH)}${call.route} (${call.transport})\n`);
        writeOut(`${"method".padEnd(DETAIL_LABEL_WIDTH)}${call.method} ${call.path}\n`);
        writeOut(`${"status".padEnd(DETAIL_LABEL_WIDTH)}${formatStatus(call)}\n`);
        if (call.request !== undefined) {
          writeOut(formatPayload("request", call.request));
        }
        if (call.response !== undefined) {
          writeOut(formatPayload("response", call.response));
        }
        const attrs = Object.entries(call.attributes);
        if (attrs.length > 0) {
          writeOut("attributes\n");
          for (const [key, value] of attrs) {
            writeOut(`  ${key}  ${JSON.stringify(value)}\n`);
          }
        }
        if (call.traceId) {
          writeOut(`trace     ${call.traceId}\n`);
        }
      } finally {
        await ctrl.close();
      }
    });
}
