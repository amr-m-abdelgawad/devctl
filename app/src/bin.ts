#!/usr/bin/env bun
import "./adapters/google/gcp-env.ts";
import { silenceGcpMetadataWarnings } from "./shared/warnings.ts";
import { createClient } from "./bootstrap/client.ts";
import { runDaemon } from "./bootstrap/daemon.ts";
import { execute } from "./presentation/cli/cli.ts";

silenceGcpMetadataWarnings();
await execute(createClient(), runDaemon);
