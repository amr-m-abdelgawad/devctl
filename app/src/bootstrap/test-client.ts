import { createClient } from "./client.ts";
import { runDaemon } from "./daemon.ts";
import { newRoot as createRoot } from "../presentation/cli/cli.ts";
export function newRoot() { return createRoot(createClient(), runDaemon); }
