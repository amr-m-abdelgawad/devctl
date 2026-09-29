#!/usr/bin/env bun
import "./adapters/google/gcp-env.ts";
import { silenceGcpMetadataWarnings } from "./shared/warnings.ts";
import { runFifoDrain } from "./adapters/process/fifo-drain.ts";
import { createClient } from "./bootstrap/client.ts";
import { runDaemon } from "./bootstrap/daemon.ts";
import { execute } from "./presentation/cli/cli.ts";

silenceGcpMetadataWarnings();
const drainIndex = process.argv.indexOf("_fifo_drain");
if (drainIndex >= 0) {
  const maxBytes = Number(process.argv[drainIndex + 3] ?? "");
  await runFifoDrain(
    process.argv[drainIndex + 1] ?? "",
    process.argv[drainIndex + 2] ?? "",
    Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : undefined,
  );
  process.exit(0);
}
await execute(createClient(), runDaemon);
