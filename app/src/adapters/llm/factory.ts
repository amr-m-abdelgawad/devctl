import type { LlmSourceDriver, LlmSourceFactory } from "../../ports/llm-source.ts";
import { litellmDriver } from "./litellm.ts";
import { proxyDriver } from "./proxy-driver.ts";

export function llmSourceFactory(plugins: LlmSourceDriver[] = []): LlmSourceFactory {
  const builtins = [litellmDriver(), proxyDriver()];
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
