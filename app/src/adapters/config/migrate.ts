import { KindConfiguration, newError } from "../../shared/errors.ts";
import { CurrentVersion, type DevctlConfig } from "../../domain/config/types.ts";

export function migrate(cfg: DevctlConfig): DevctlConfig {
  if (cfg.version === 0) {
    throw newError(KindConfiguration, "version is required");
  }
  if (cfg.version === CurrentVersion) {
    return cfg;
  }
  throw newError(
    KindConfiguration,
    `unsupported config version ${cfg.version} (expected ${CurrentVersion}); no migration is available`,
  );
}
