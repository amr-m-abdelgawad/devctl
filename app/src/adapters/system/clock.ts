import type { Clock } from "../../ports/clock.ts";

export const systemClock: Clock = {
  now: () => new Date(),
  isoNow: () => new Date().toISOString(),
  unixMs: () => Date.now(),
};
