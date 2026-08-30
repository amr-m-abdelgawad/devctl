#!/usr/bin/env bun
import "./gcp-env.ts";
import { silenceGcpMetadataWarnings } from "./warnings.ts";
import { execute } from "./cli.ts";

silenceGcpMetadataWarnings();
await execute();
