export type HostLimits = {
  /** cgroup memory.max, else host MemTotal. 0 when unknown. */
  memoryBytes: number;
  /** cgroup memory.current. Undefined when not in a cgroup. */
  memoryUsedBytes?: number;
  /** cgroup pids.max. Undefined when unlimited or unknown. */
  pidsMax?: number;
  freeDiskBytes: number;
  totalDiskBytes: number;
  /** True when PID 1 looks like a non-reaping pause container (`sleep`, `tail`, …). */
  nonReapingPid1: boolean;
  pid1Command: string;
};

export type HostLimitsReader = {
  read(): HostLimits;
};
