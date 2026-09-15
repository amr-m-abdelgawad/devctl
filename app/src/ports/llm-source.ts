import type { LlmSourceConfig } from "../domain/config/types.ts";
import type { LlmCallIngest, LlmSourceCapabilities } from "../domain/llm/llm.ts";

export type LlmSourceContext = {
  baseUrl: string;
  pathPrefix: string;
  headers: Record<string, string>;
  since?: string;
};

// "pull" drivers are polled on a timer by the LlmCoordinator (LiteLLM spend
// logs). "push" drivers receive calls out of band — e.g. the proxy-capture
// sink feeding bodies straight into the store — so the coordinator must not
// poll them. Absent means "pull" for backward compatibility with plugins.
export type LlmSourceMode = "pull" | "push";

export type LlmSourceDriver = {
  name: string;
  mode?: LlmSourceMode;
  capabilities: (cfg: LlmSourceConfig) => LlmSourceCapabilities;
  fetch: (cfg: LlmSourceConfig, ctx: LlmSourceContext) => Promise<LlmCallIngest[]>;
};

export type LlmSourceFactory = {
  lookup(type: string): LlmSourceDriver | undefined;
};
