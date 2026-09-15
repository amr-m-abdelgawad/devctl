import { LLM_SOURCE_TYPE_PROXY, type LlmSourceConfig } from "../../domain/config/types.ts";
import type { LlmSourceCapabilities } from "../../domain/llm/llm.ts";
import type { LlmSourceDriver } from "../../ports/llm-source.ts";

// The proxy source is push-only: bodies arrive through the proxy-capture sink,
// not by polling. This driver exists so the type is a recognised builtin and
// the coordinator can see `mode: "push"` and register no timer for it. `fetch`
// is never called (the coordinator skips push sources) and returns nothing.
export function proxyDriver(): LlmSourceDriver {
  return {
    name: LLM_SOURCE_TYPE_PROXY,
    mode: "push",
    capabilities: (cfg) => capabilitiesFor(cfg),
    fetch: async () => [],
  };
}

function capabilitiesFor(cfg: LlmSourceConfig): LlmSourceCapabilities {
  return {
    hasBodies: cfg.capture.prompts,
    hasCost: false,
    // LiteLLM omits usage on streamed responses unless the caller sets
    // stream_options.include_usage, so capture can't promise token counts.
    hasUsage: false,
    liveQuery: true,
  };
}
