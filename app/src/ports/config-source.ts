import type { DevctlConfig } from "../domain/config/types.ts";

export type ConfigSource = {
  load(repoRoot: string, configPath: string): DevctlConfig;
};
