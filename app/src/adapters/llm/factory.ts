import type { LlmSourceDriver, LlmSourceFactory } from "../../ports/llm-source.ts";
import { litellmDriver } from "./litellm.ts";

export function llmSourceFactory(plugins: LlmSourceDriver[] = []): LlmSourceFactory {
  const builtins = [litellmDriver()];
  return {
    lookup(type: string) {
      const kind = type.toLowerCase();
      const plugin = plugins.find((entry) => entry.name.toLowerCase() === kind);
      if (plugin) {
        return plugin;
      }
      return builtins.find((entry) => entry.name.toLowerCase() === kind);
    },
  };
}
