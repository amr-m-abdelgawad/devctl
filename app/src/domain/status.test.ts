import { describe, expect, test } from "bun:test";
import { daemonStatusLine, instanceStatusLine } from "./status.ts";

describe("daemonStatusLine", () => {
  test("a daemon running both workers, or one that does not report them, has no line", () => {
    expect(daemonStatusLine(undefined)).toBeUndefined();
    expect(daemonStatusLine({ rssBytes: 1, heapBytes: 1 })).toBeUndefined();
    expect(daemonStatusLine({ rssBytes: 1, heapBytes: 1, logStore: "worker", watchdog: "ok" })).toBeUndefined();
  });

  test("names each missing worker", () => {
    expect(daemonStatusLine({ rssBytes: 1, heapBytes: 1, logStore: "worker", watchdog: "degraded" })).toBe("DAEMON      DEGRADED    watchdog worker down");
    expect(daemonStatusLine({ rssBytes: 1, heapBytes: 1, logStore: "in-process", watchdog: "degraded" })).toBe("DAEMON      DEGRADED    watchdog worker down, log store in-process");
  });
});

describe("instanceStatusLine", () => {
  test("a checkout's own stack in slot 0 has no line", () => {
    expect(instanceStatusLine(undefined)).toBeUndefined();
    expect(instanceStatusLine({ name: "", slot: 0, port_offset: 0 })).toBeUndefined();
  });

  test("names the slot, and the instance when it has one", () => {
    expect(instanceStatusLine({ slot: 1, port_offset: 100 })).toBe("INSTANCE: slot 1 (ports +100)");
    expect(instanceStatusLine({ name: "ci-7", slot: 2, port_offset: 200 })).toBe("INSTANCE: ci-7, slot 2 (ports +200)");
  });
});
