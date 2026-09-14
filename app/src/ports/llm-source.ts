import type { LlmSourceConfig } from "../domain/config/types.ts";
import type { LlmCallIngest, LlmSourceCapabilities } from "../domain/llm/llm.ts";

export type LlmSourceContext = {
  baseUrl: string;
  pathPrefix: string;
  headers: Record<string, string>;
  since?: string;
};

export type LlmSourceDriver = {
  name: string;
  capabilities: (cfg: LlmSourceConfig) => LlmSourceCapabilities;
  fetch: (cfg: LlmSourceConfig, ctx: LlmSourceContext) => Promise<LlmCallIngest[]>;
};

export type LlmSourceFactory = {
  lookup(type: string): LlmSourceDriver | undefined;
};
