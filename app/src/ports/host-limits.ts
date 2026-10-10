export type HostLimits = {
  /** The binding cgroup memory limit, else host MemTotal. 0 when unknown. */
  memoryBytes: number;
  /** That cgroup's working set: usage less inactive file cache, as `docker stats` reports. Undefined when no cgroup limit applies. */
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
