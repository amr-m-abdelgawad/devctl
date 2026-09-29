#!/usr/bin/env bun
import "./adapters/google/gcp-env.ts";
import { silenceGcpMetadataWarnings } from "./shared/warnings.ts";
import { runDrainCommand } from "./adapters/process/fifo-drain.ts";
import { createClient } from "./bootstrap/client.ts";
import { runDaemon } from "./bootstrap/daemon.ts";
import { execute } from "./presentation/cli/cli.ts";

silenceGcpMetadataWarnings();
// Exec'd by a daemon's stdio sentinel once the daemon is gone.
const drainAll = process.argv.indexOf("_drain");
if (drainAll >= 0) {
  await runDrainCommand(process.argv[drainAll + 1] ?? "");
  process.exit(0);
}
await execute(createClient(), runDaemon);
