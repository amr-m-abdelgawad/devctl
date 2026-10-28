export type StreamMetrics = {
  ingestBytes: number;
  inFlightBytes: number;
  spooledBytes: number;
  rateLimited: boolean;
};

export type PersistenceMetrics = {
  backlogBytes: number;
  diskBytes: number;
  loss: number;
  paused: boolean;
};

export type DaemonMetrics = {
  eventLoopLagMs: number;
  rssBytes: number;
  heapBytes: number;
  cgroupUsageBytes?: number;
  cgroupLimitBytes?: number;
  streams: Record<string, StreamMetrics>;
  persistence: PersistenceMetrics;
  ringBytes: number;
  captureBytes: number;
  captureBodiesShed: boolean;
};

export type DaemonMetricsSource = {
  snapshot(): DaemonMetrics;
};

export function emptyDaemonMetrics(): DaemonMetrics {
  return {
    eventLoopLagMs: 0,
    rssBytes: 0,
    heapBytes: 0,
    streams: {},
    persistence: { backlogBytes: 0, diskBytes: 0, loss: 0, paused: false },
    ringBytes: 0,
    captureBytes: 0,
    captureBodiesShed: false,
  };
}
