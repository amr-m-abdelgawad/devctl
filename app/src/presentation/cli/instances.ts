import { Command } from "commander";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import { slotOffset, type InstanceSlot } from "../../domain/net/port-slots.ts";
import { shutdownTimeoutFor, waitUntilUnreachable } from "./lifecycle.ts";
import { withInstance, writeOut } from "./shared.ts";

type InstanceRow = InstanceSlot & { offset: number; status: "running" | "stopped" | "missing" };

// Parallel stacks (#117): list the stacks holding port slots (a checkout, or a
// named `--instance` of one), and free the slots of deleted checkouts. Each
// row is probed and stopped as its own instance.
export function addInstances(root: Command, runtime: ClientRuntime): void {
  const instances = root
    .command("instances")
    .description("list the parallel stacks (checkouts and named instances), with their port slots")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const rows = await instanceRows(runtime);
      if (opts.json) {
        writeOut(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      writeOut(formatInstances(rows));
    });
  instances
    .command("prune")
    .description("stop the stacks of deleted checkouts and free their port slots")
    .action(async () => {
      const stale = (await instanceRows(runtime)).filter((row) => row.status === "missing");
      if (stale.length === 0) {
        writeOut("no instances to prune\n");
        return;
      }
      const kept: string[] = [];
      for (const row of stale) {
        await withInstance(row.instance, async () => {
          const { client } = await runtime.findDaemon("", row.repoRoot);
          if (client) {
            const timeout = await shutdownTimeoutFor(client);
            try {
              await client.call("shutdown", { stop_services: true }, timeout);
            } finally {
              client.close();
            }
            await waitUntilUnreachable(runtime, row.repoRoot, timeout);
          }
          // The slot's ports are free only once nothing of the stack is left:
          // a supervisor that outlived its shutdown deadline, or services a
          // `down --keep-services` left running with no supervisor at all.
          const blocker = await stillRunning(runtime, row.repoRoot);
          if (blocker !== undefined) {
            kept.push(`slot ${row.slot} (${stackLabel(row)}): ${blocker}`);
            return;
          }
          runtime.releaseInstance(row.repoRoot);
          writeOut(`pruned slot ${row.slot} (${stackLabel(row)})${client ? "; stopped its services and supervisor" : ""}\n`);
        });
      }
      if (kept.length > 0) {
        throw new Error(`kept ${kept.length === 1 ? "a port slot" : `${kept.length} port slots`} whose stack is still running:\n  ${kept.join("\n  ")}`);
      }
    });
}

/** Why a pruned checkout's slot can't be freed yet, or undefined once its stack is gone. */
export async function stillRunning(runtime: Pick<ClientRuntime, "tryDial" | "readPersistedState" | "processAlive">, repoRoot: string): Promise<string | undefined> {
  const client = await runtime.tryDial(repoRoot);
  if (client) {
    client.close();
    return "its supervisor did not stop in time; run `devctl instances prune` again";
  }
  const alive = (runtime.readPersistedState(repoRoot)?.processes ?? []).filter((proc) => proc.pid > 0 && runtime.processAlive(proc.pid));
  if (alive.length > 0) {
    return `services still running (${alive.map((proc) => `${proc.name} pid ${proc.pid}`).join(", ")}); stop them, then prune again`;
  }
  return undefined;
}

async function instanceRows(runtime: ClientRuntime): Promise<InstanceRow[]> {
  const rows: InstanceRow[] = [];
  for (const entry of runtime.listInstances()) {
    // A deleted checkout is "missing" even while its stack still runs: that's
    // exactly what prune is for.
    let status: InstanceRow["status"] = "missing";
    if (runtime.fileExists(entry.repoRoot)) {
      const client = await withInstance(entry.instance, () => runtime.tryDial(entry.repoRoot));
      status = client ? "running" : "stopped";
      client?.close();
    }
    rows.push({ ...entry, offset: slotOffset(entry.slot), status });
  }
  return rows;
}

export function formatInstances(rows: readonly InstanceRow[]): string {
  if (rows.length === 0) {
    return "no stacks hold a port slot\n";
  }
  const header = ["SLOT", "OFFSET", "CHECKOUT", "INSTANCE", "PROXY", "WEB", "OTLP", "STATUS"];
  const body = rows.map((row) => [
    String(row.slot),
    `+${row.offset}`,
    row.repoRoot,
    row.instance ?? "-",
    port(row.ports?.proxy),
    port(row.ports?.web),
    port(row.ports?.otlp),
    row.status === "missing" ? "missing (run `devctl instances prune`)" : row.status,
  ]);
  const widths = header.map((title, col) => Math.max(title.length, ...body.map((cells) => (cells[col] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, col) => (col === cells.length - 1 ? cell : cell.padEnd(widths[col] ?? 0))).join("  ");
  return `${[line(header), ...body.map(line)].join("\n")}\n`;
}

function stackLabel(row: InstanceSlot): string {
  return row.instance ? `${row.repoRoot}, instance ${row.instance}` : row.repoRoot;
}

function port(value: number | undefined): string {
  return value === undefined ? "-" : String(value);
}
