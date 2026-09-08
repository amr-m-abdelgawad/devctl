import type { Clock } from "../../ports/clock.ts";

export const systemClock: Clock = {
  now: () => new Date(),
  isoNow: () => new Date().toISOString(),
  unixMs: () => Date.now(),
};

export class FakeClock implements Clock {
  constructor(private current: Date = new Date(0)) {}

  now(): Date {
    return this.current;
  }

  isoNow(): string {
    return this.current.toISOString();
  }

  unixMs(): number {
    return this.current.getTime();
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(next: Date): void {
    this.current = next;
  }
}
