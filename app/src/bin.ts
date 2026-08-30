#!/usr/bin/env bun
import { silenceGcpMetadataWarnings } from "./warnings.ts";
import { execute } from "./cli.ts";

silenceGcpMetadataWarnings();
await execute();
