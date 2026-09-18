import { Command } from "commander";
import { setTimeout as delay } from "node:timers/promises";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import type { LlmCall, LlmCallFilter, LlmCallPage } from "../../domain/llm/llm.ts";
import { configFlag, writeOut } from "./shared.ts";

const DETAIL_LABEL_WIDTH = 10;

function formatTokens(call: LlmCall): string {
  const total = call.usage?.totalTokens ?? ((call.usage?.promptTokens ?? 0) + (call.usage?.completionTokens ?? 0));
  return total > 0 ? String(total) : "—";
}

function formatCost(call: LlmCall): string {
  return call.cost === undefined ? "—" : `$${call.cost.toFixed(4)}`;
}

function formatDuration(call: LlmCall): string {
  if (call.durationMs === undefined) {
    return "—";
  }
  return `${call.durationMs}ms`;
}

function formatCaller(call: LlmCall): string {
  return call.caller && call.caller.trim() !== "" ? call.caller : "—";
}

export function formatLlmCallLine(call: LlmCall): string {
  const time = call.timestamp.slice(11, 19) || call.timestamp;
  return `${time} ${call.status.padEnd(5)} ${formatCaller(call).padEnd(14)} ${call.model.padEnd(24)} ${formatDuration(call).padEnd(8)} ${formatTokens(call).padEnd(6)} ${formatCost(call).padEnd(10)} ${call.source} ${call.id}\n`;
}

export async function followLlmCalls(
  fetchPage: () => Promise<LlmCallPage>,
  onCall: (call: LlmCall) => void,
  signal: AbortSignal,
  pollMs = 1000,
): Promise<void> {
  const seen = new Set<string>();
  const emit = (calls: readonly LlmCall[]): void => {
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

export function addLlm(root: Command, runtime: ClientRuntime): void {
  const llm = root.command("llm").description("inspect LLM calls from configured sources");
  llm
    .option("--source <name>", "filter by llm source name")
    .option("--caller <name>", "filter by originating service (use '-' or 'none' for calls with no caller)")
    .option("--model <name>", "filter by requested or routed model")
    .option("--status <status>", "ok or error")
    .option("--search <text>", "substring search")
    .option("--since <timestamp>", "only calls at or after this ISO timestamp")
    .option("--until <timestamp>", "only calls at or before this ISO timestamp")
    .option("--json", "JSONL output")
    .option("-f, --follow", "keep printing new matching calls until interrupted")
    .action(async (opts: {
      source?: string;
      caller?: string;
      model?: string;
      status?: string;
      search?: string;
      since?: string;
      until?: string;
      json?: boolean;
      follow?: boolean;
    }) => {
      const ctrl = await runtime.openController("", configFlag(root), true);
      try {
        const filter: LlmCallFilter = {
          source: opts.source,
          caller: opts.caller === "none" ? "-" : opts.caller,
          model: opts.model,
          status: opts.status === "ok" || opts.status === "error" ? opts.status : undefined,
          search: opts.search,
          since: opts.since,
          until: opts.until,
        };
        const printCall = (call: LlmCall): void => {
          writeOut(opts.json ? `${JSON.stringify(call)}\n` : formatLlmCallLine(call));
        };
        if (opts.follow) {
          const abort = new AbortController();
          const onSignal = (): void => abort.abort();
          process.on("SIGINT", onSignal);
          process.on("SIGTERM", onSignal);
          try {
            await followLlmCalls(() => ctrl.llmCallsPage(filter), printCall, abort.signal);
          } finally {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
          }
          return;
        }
        const page = await ctrl.llmCallsPage(filter);
        for (const err of page.errors) {
          writeOut(`! ${err.source}: ${err.message}\n`);
        }
        for (const call of page.calls) {
          printCall(call);
        }
      } finally {
        await ctrl.close();
      }
    });
  llm
    .command("show")
    .argument("<id>", "call id")
    .option("--json", "JSON output")
    .action(async (id: string, opts: { json?: boolean }) => {
      const ctrl = await runtime.openController("", configFlag(root), true);
      try {
        const call = await ctrl.getLlmCall(id);
        if (!call) {
          writeOut(`llm call ${id} not found\n`);
          process.exitCode = 1;
          return;
        }
        if (opts.json) {
          writeOut(`${JSON.stringify(call, null, 2)}\n`);
          return;
        }
        writeOut(formatLlmCallLine(call));
        writeOut(`${"caller".padEnd(DETAIL_LABEL_WIDTH)}${formatCaller(call)}\n`);
        writeOut(`${(call.sourceType === "proxy" ? "via" : "source").padEnd(DETAIL_LABEL_WIDTH)}${call.source} (${call.sourceType})\n`);
        if (call.error) {
          writeOut(`error     ${call.error}\n`);
        }
        if (call.request !== undefined) {
          writeOut(`request   ${JSON.stringify(call.request, null, 2)}\n`);
        }
        if (call.response !== undefined) {
          writeOut(`response  ${JSON.stringify(call.response, null, 2)}\n`);
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
