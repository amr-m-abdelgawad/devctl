#!/usr/bin/env bun
import "./adapters/google/gcp-env.ts";
import { silenceGcpMetadataWarnings } from "./warnings.ts";
import { execute } from "./presentation/cli/cli.ts";

silenceGcpMetadataWarnings();
await execute();
