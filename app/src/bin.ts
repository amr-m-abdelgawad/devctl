#!/usr/bin/env bun
// Exec'd by a daemon's stdio sentinel once the daemon is gone. It loads only
// the drainer, not the CLI, so it stays small for as long as no daemon runs.
const drainAll = process.argv.indexOf("_drain");
if (drainAll >= 0) {
  const { runDrainCommand } = await import("./adapters/process/fifo-drain.ts");
  await runDrainCommand(process.argv[drainAll + 1] ?? "");
  process.exit(0);
}
// First, so the Google libraries see these defaults when they load.
await import("./adapters/google/gcp-env.ts");
const { silenceGcpMetadataWarnings } = await import("./shared/warnings.ts");
const { createClient } = await import("./bootstrap/client.ts");
const { runDaemon } = await import("./bootstrap/daemon.ts");
const { execute } = await import("./presentation/cli/cli.ts");

silenceGcpMetadataWarnings();
await execute(createClient(), runDaemon);
