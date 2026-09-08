import { describe, expect, test } from "bun:test";
import { Bus, ServiceStarted, newEvent } from "./events.ts";

describe("event bus", () => {
  test("publishes to matching subscribers", () => {
    const bus = new Bus(8);
    const seen: string[] = [];
    const off = bus.subscribe((ev) => seen.push(ev.type), [ServiceStarted]);
    bus.publish(newEvent(ServiceStarted, "api", {}));
    bus.publish(newEvent("Other", "api", {}));
    expect(seen).toEqual([ServiceStarted]);
    off();
    bus.publish(newEvent(ServiceStarted, "api", {}));
    expect(seen).toEqual([ServiceStarted]);
    expect(bus.recent()).toHaveLength(3);
  });
});
