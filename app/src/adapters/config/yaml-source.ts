import { load } from "./load.ts";
import type { ConfigSource } from "../../ports/config-source.ts";

export const yamlConfigSource: ConfigSource = { load };
