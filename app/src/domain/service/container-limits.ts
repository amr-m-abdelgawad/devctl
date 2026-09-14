import type { ContainerConfig } from "../config/types.ts";

export const DEFAULT_CONTAINER_MEMORY = "1g";
export const DEFAULT_CONTAINER_CPUS = "1";
export const DEFAULT_CONTAINER_PIDS_LIMIT = 256;

export type ContainerLimits = {
  user: string;
  memory: string;
  cpus: string;
  readOnly: boolean;
  capDrop: string[];
  pidsLimit: number;
};

export function resolvedContainerLimits(cfg: ContainerConfig): ContainerLimits {
  const memory = cfg.memory.trim();
  const cpus = cfg.cpus.trim();
  return {
    user: cfg.user.trim(),
    memory: memory === "" ? DEFAULT_CONTAINER_MEMORY : memory,
    cpus: cpus === "" ? DEFAULT_CONTAINER_CPUS : cpus,
    readOnly: cfg.read_only,
    capDrop: cfg.cap_drop.map((cap) => cap.trim()).filter((cap) => cap !== ""),
    pidsLimit: cfg.pids_limit > 0 ? cfg.pids_limit : DEFAULT_CONTAINER_PIDS_LIMIT,
  };
}

export function isImageUserRoot(user: string): boolean {
  const value = user.trim().toLowerCase();
  return value === "" || value === "0" || value === "0:0" || value === "root";
}
